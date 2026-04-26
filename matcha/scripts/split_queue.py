#!/usr/bin/env python3
"""split_queue.py — Split inbox articles into individual queue files for the librarian.

After collect.sh or arxiv_trickle.py appends to ~/vault/raw/inbox/YYYY-MM-DD-articles.md,
this script parses it and creates individual queue files in ~/vault/raw/inbox/queue/:
    001.md, 002.md, ...

Each queue file contains one article with its title, source, URL, date, abstract, and batch info.
Already-queued articles (by title dedup) are skipped so re-runs are idempotent.

Usage:
    python3 split_queue.py

Environment:
    VAULT_DIR   Path to vault (default: ~/vault)
"""
import os
import re
import sys
from pathlib import Path
from datetime import datetime
from difflib import SequenceMatcher

VAULT_DIR = os.environ.get("VAULT_DIR", os.path.expanduser("~/vault"))
INBOX_DIR = os.path.join(VAULT_DIR, "raw", "inbox")
QUEUE_DIR = os.path.join(INBOX_DIR, "queue")

DUP_THRESHOLD = 0.85


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def get_next_queue_num() -> int:
    """Find the next available queue number."""
    if not os.path.isdir(QUEUE_DIR):
        return 1
    existing = [int(f.stem) for f in Path(QUEUE_DIR).glob("*.md") if f.stem.isdigit()]
    return max(existing, default=0) + 1


def get_queued_titles() -> list:
    """Load titles of already-queued articles for dedup."""
    titles = []
    if not os.path.isdir(QUEUE_DIR):
        return titles
    for f in Path(QUEUE_DIR).glob("*.md"):
        text = f.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^title:\s*(.+)$", text, re.MULTILINE)
        if m:
            titles.append(m.group(1).lower().strip())
    return titles


def is_duplicate(title: str, existing: list) -> bool:
    title_lower = title.lower().strip()
    return any(SequenceMatcher(None, title_lower, t).ratio() > DUP_THRESHOLD for t in existing)


def write_queue_file(num: int, article: dict) -> str:
    path = os.path.join(QUEUE_DIR, f"{num:04d}.md")
    content = (
        f"title: {article['title']}\n"
        f"source: {article.get('source', 'unknown')}\n"
        f"url: {article.get('url', '')}\n"
        f"date: {article.get('date', '')}\n"
        f"batch: {article.get('batch', '')}\n"
        f"---\n"
        f"# {article['title']}\n\n"
        f"**Source:** [{article.get('source', 'unknown')}]({article.get('url', '#')})\n"
    )
    if article.get('date'):
        content += f"**Date:** {article['date']}\n"
    if article.get('abstract'):
        content += f"\n{article['abstract']}\n"
    content += f"\n---\n*Collected: {article.get('batch', 'unknown')}*\n"
    Path(path).write_text(content, encoding="utf-8")
    return path


def parse_trickle_block(lines: list, section_header: str) -> list:
    """Parse trickle-format articles (from arxiv_trickle.py).

    - **Title**
      - Source: [arXiv](url)
      - Date: YYYY-MM-DD
      - abstract...
    """
    articles = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'^- \*\*(.+?)\*\*$', line.strip())
        if not m:
            i += 1
            continue

        title = m.group(1).strip()
        article = {"title": title, "source": "", "url": "", "date": "", "abstract": "", "batch": section_header}
        i += 1

        # Collect indented metadata lines
        while i < len(lines) and (lines[i].startswith("  ") or lines[i].startswith("\t")):
            meta = lines[i].strip()
            # Source: [name](url)
            sm = re.match(r'Source:\s*\[(.+?)\]\((.+?)\)', meta)
            if sm:
                article["source"] = sm.group(1)
                article["url"] = sm.group(2)
            # Date: YYYY-MM-DD
            dm = re.match(r'Date:\s*(.+)', meta)
            if dm:
                article["date"] = dm.group(1)
            # Abstract (lines not matching metadata patterns)
            elif not meta.startswith("- Source:") and not meta.startswith("- Date:"):
                if article["abstract"]:
                    article["abstract"] += " "
                article["abstract"] += meta
            i += 1

        if title:
            articles.append(article)
    return articles


def parse_collect_block(lines: list, section_header: str) -> list:
    """Parse collect-format articles (from filter_matcha.py).

    - [Title](url) *(Source)* — abstract...
    """
    articles = []
    for line in lines:
        stripped = line.strip()
        # Match: - [Title](url) *(Source)* — abstract
        # Use [^\]]+ and [^)]+ for robust matching (handles HTML tags in titles)
        m = re.match(r'^- \[([^\]]+)\]\(([^)]+)\)\s*\*\(([^)]*)\)\*\s*(.*)?$', stripped)
        if not m:
            # Try without source tag: - [Title](url)
            m = re.match(r'^- \[([^\]]+)\]\(([^)]+)\)\s*(.*)?$', stripped)
            if not m:
                continue
            title = m.group(1).strip()
            url = m.group(2).strip()
            abstract = (m.group(3) or "").strip()
            source = ""
        else:
            title = m.group(1).strip()
            url = m.group(2).strip()
            source = m.group(3).strip()
            abstract = (m.group(4) or "").strip()

        if title and title not in ("💬", "🔥", "_"):
            # Clean icon prefixes
            title = re.sub(r'^([^\w\s]+[\s]*)+', '', title).strip()
            if not title:
                title = m.group(1).strip()
            # Strip HTML tags from title
            title = re.sub(r'<[^>]+>', '', title).strip()
            articles.append({
                "title": title,
                "source": source,
                "url": url,
                "date": "",
                "abstract": abstract,
                "batch": section_header,
            })
    return articles


def parse_inbox_file(filepath: str) -> list:
    """Parse an inbox file and return all articles."""
    if not os.path.isfile(filepath):
        return []

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    lines = content.split("\n")
    all_articles = []

    # Skip YAML frontmatter at top
    start = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start = i + 1
                break

    current_section = ""
    current_lines = []
    in_section = False

    for line in lines[start:]:
        # Detect section headers (### or ##)
        header_m = re.match(r'^(##+)\s+(.+)$', line)
        if header_m:
            # Flush previous section
            if in_section and current_lines:
                if current_section.startswith("Trickle"):
                    all_articles.extend(parse_trickle_block(current_lines, current_section))
                else:
                    all_articles.extend(parse_collect_block(current_lines, current_section))
            current_section = header_m.group(2).strip()
            current_lines = []
            in_section = True
        elif line.strip() == "---":
            continue
        elif in_section:
            current_lines.append(line)

    # Flush last section
    if in_section and current_lines:
        if current_section.startswith("Trickle"):
            all_articles.extend(parse_trickle_block(current_lines, current_section))
        else:
            all_articles.extend(parse_collect_block(current_lines, current_section))

    return all_articles


def main():
    log(f"split_queue.py — scanning inbox in {INBOX_DIR}")

    os.makedirs(QUEUE_DIR, exist_ok=True)

    queued_titles = get_queued_titles()
    log(f"Already queued: {len(queued_titles)} articles")

    inbox_files = sorted(Path(INBOX_DIR).glob("*-articles.md"))
    if not inbox_files:
        log("No inbox files found. Nothing to split.")
        return 0

    total_new = 0
    total_skipped = 0
    next_num = get_next_queue_num()

    for inbox_file in inbox_files:
        articles = parse_inbox_file(str(inbox_file))
        log(f"Parsed {len(articles)} articles from {inbox_file.name}")

        for article in articles:
            if is_duplicate(article["title"], queued_titles):
                total_skipped += 1
                continue

            write_queue_file(next_num, article)
            queued_titles.append(article["title"].lower().strip())
            next_num += 1
            total_new += 1

    log(f"Done: {total_new} new queue files, {total_skipped} skipped (dups/already queued)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

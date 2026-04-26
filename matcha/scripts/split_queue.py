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
import html as html_lib
import time
import urllib.robotparser
import urllib.request
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from pathlib import Path
from datetime import datetime
from difflib import SequenceMatcher

VAULT_DIR = os.environ.get("VAULT_DIR", os.path.expanduser("~/vault"))
INBOX_DIR = os.path.join(VAULT_DIR, "raw", "inbox")
QUEUE_DIR = os.path.join(INBOX_DIR, "queue")
SKIP_DIR = os.path.join(QUEUE_DIR, "skip")

DUP_THRESHOLD = 0.85
USER_AGENT = "Matcha/1.0 (research digest)"
FETCH_TIMEOUT = 15
FETCH_DELAY_SECONDS = 0.5
FETCH_MIN_CHARS = 200
FETCH_ABSTRACT_THRESHOLD = 50
MAX_FETCH_BYTES = 2_000_000

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

_robots_cache = {}
_last_fetch_at = 0.0


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def get_next_queue_num() -> int:
    """Find the next available queue number."""
    if not os.path.isdir(QUEUE_DIR):
        return 1
    existing = [int(f.stem) for f in Path(QUEUE_DIR).glob("*.md") if f.stem.isdigit()]
    if os.path.isdir(SKIP_DIR):
        existing.extend(int(f.stem) for f in Path(SKIP_DIR).glob("*.md") if f.stem.isdigit())
    return max(existing, default=0) + 1


def get_queued_titles() -> list:
    """Load titles of already-queued articles for dedup."""
    titles = []
    if not os.path.isdir(QUEUE_DIR):
        return titles
    queue_files = list(Path(QUEUE_DIR).glob("*.md"))
    if os.path.isdir(SKIP_DIR):
        queue_files.extend(Path(SKIP_DIR).glob("*.md"))
    for f in queue_files:
        text = f.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^title:\s*(.+)$", text, re.MULTILINE)
        if m:
            titles.append(m.group(1).lower().strip())
    return titles


def is_duplicate(title: str, existing: list) -> bool:
    title_lower = title.lower().strip()
    return any(SequenceMatcher(None, title_lower, t).ratio() > DUP_THRESHOLD for t in existing)


def normalize_text(text: str) -> str:
    """Collapse extracted HTML text into readable paragraphs."""
    text = re.sub(r"\r\n?", "\n", text or "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def robots_allowed(url: str) -> bool:
    """Return whether robots.txt allows this user agent to fetch the URL."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False

    robots_url = urlunparse((parsed.scheme, parsed.netloc, "/robots.txt", "", "", ""))
    if robots_url not in _robots_cache:
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(robots_url)
        request = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
                robots_txt = response.read(MAX_FETCH_BYTES).decode("utf-8", errors="replace")
            parser.parse(robots_txt.splitlines())
            _robots_cache[robots_url] = parser
        except HTTPError as exc:
            if exc.code in (401, 403):
                log(f"robots.txt forbids access for {parsed.netloc}: HTTP {exc.code}")
                _robots_cache[robots_url] = False
            else:
                log(f"robots.txt unavailable for {parsed.netloc}: HTTP {exc.code}")
                _robots_cache[robots_url] = None
        except Exception as exc:
            log(f"robots.txt unavailable for {parsed.netloc}: {exc}")
            _robots_cache[robots_url] = None

    parser = _robots_cache[robots_url]
    if parser is False:
        return False
    return True if parser is None else parser.can_fetch(USER_AGENT, url)


def rate_limit_fetch() -> None:
    """Sleep as needed so article fetches are spaced out."""
    global _last_fetch_at
    elapsed = time.monotonic() - _last_fetch_at
    if _last_fetch_at and elapsed < FETCH_DELAY_SECONDS:
        time.sleep(FETCH_DELAY_SECONDS - elapsed)
    _last_fetch_at = time.monotonic()


def extract_with_bs4(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    selectors = [
        "article",
        '[role="article"]',
        ".article-body",
        ".article__body",
        ".article-content",
        ".entry-content",
        ".post-content",
        ".story-body",
        ".body-content",
        ".content-body",
        "main",
    ]
    candidates = []
    for selector in selectors:
        candidates.extend(soup.select(selector))

    if not candidates:
        candidates = [soup.body or soup]

    best = max(
        (normalize_text(candidate.get_text("\n", strip=True)) for candidate in candidates),
        key=len,
        default="",
    )
    return best


def extract_with_regex(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", html)
    patterns = [
        r"(?is)<article\b[^>]*>(.*?)</article>",
        r'(?is)<div\b[^>]*(?:class|id)=["\'][^"\']*(?:article-body|article__body|article-content|entry-content|post-content|story-body|body-content|content-body)[^"\']*["\'][^>]*>(.*?)</div>',
        r"(?is)<main\b[^>]*>(.*?)</main>",
    ]
    candidates = []
    for pattern in patterns:
        candidates.extend(match.group(1) for match in re.finditer(pattern, html))

    if not candidates:
        candidates = [html]

    text_candidates = []
    for candidate in candidates:
        text = re.sub(r"(?i)<br\s*/?>", "\n", candidate)
        text = re.sub(r"(?i)</p\s*>", "\n\n", text)
        text = re.sub(r"<[^>]+>", " ", text)
        text = html_lib.unescape(text)
        text_candidates.append(normalize_text(text))

    return max(text_candidates, key=len, default="")


def extract_article_text(html: str) -> str:
    if BeautifulSoup is not None:
        return extract_with_bs4(html)
    return extract_with_regex(html)


def fetch_content(url: str) -> str:
    """Fetch a URL and extract the main article text."""
    if not url:
        return ""
    if not robots_allowed(url):
        log(f"robots.txt disallows fetch: {url}")
        return ""

    rate_limit_fetch()
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/html" not in content_type and "text/plain" not in content_type:
                log(f"Skipping non-text response for {url}: {content_type}")
                return ""
            charset = response.headers.get_content_charset() or "utf-8"
            raw = response.read(MAX_FETCH_BYTES)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        log(f"Fetch failed for {url}: {exc}")
        return ""

    html = raw.decode(charset, errors="replace")
    return extract_article_text(html)


def write_queue_file(num: int, article: dict, directory: str = QUEUE_DIR) -> str:
    path = os.path.join(directory, f"{num:04d}.md")
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
    if article.get('content'):
        content += f"\n{article['content']}\n"
    content += f"\n---\n*Collected: {article.get('batch', 'unknown')}*\n"
    Path(path).write_text(content, encoding="utf-8")
    return path


def move_to_skip(path: str) -> str:
    os.makedirs(SKIP_DIR, exist_ok=True)
    dest = os.path.join(SKIP_DIR, os.path.basename(path))
    os.replace(path, dest)
    return dest


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

            abstract = article.get("abstract", "").strip()
            if len(abstract) < FETCH_ABSTRACT_THRESHOLD:
                fetched = fetch_content(article.get("url", ""))
                if len(fetched) < FETCH_MIN_CHARS:
                    article["content"] = fetched
                    path = write_queue_file(next_num, article)
                    skipped_path = move_to_skip(path)
                    log(f"Skipped {article['title']}: fetched content under {FETCH_MIN_CHARS} chars -> {skipped_path}")
                    queued_titles.append(article["title"].lower().strip())
                    next_num += 1
                    total_skipped += 1
                    continue
                article["content"] = fetched

            path = write_queue_file(next_num, article)
            log(f"Queued {article['title']} -> {path}")
            queued_titles.append(article["title"].lower().strip())
            next_num += 1
            total_new += 1

    log(f"Done: {total_new} new queue files, {total_skipped} skipped (dups/already queued/fetch failures)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

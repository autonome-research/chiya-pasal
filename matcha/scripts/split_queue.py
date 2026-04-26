#!/usr/bin/env python3
"""split_queue.py — Split inbox articles into individual queue files for the librarian.

After collect.sh or arxiv_trickle.py appends to ~/vault/raw/inbox/YYYY-MM-DD-articles.md,
this script parses it and creates individual queue files in ~/vault/raw/inbox/queue/:
    001.md, 002.md, ...

Each queue file contains one article with its title, source, URL, date, abstract, and batch info.
Already-seen articles (by title dedup) are skipped so re-runs are idempotent even
after librarian workers delete queue files.

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
import shutil
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
ARCHIVE_DIR = os.path.join(INBOX_DIR, "archive")
SEEN_TITLES_PATH = os.environ.get("SEEN_TITLES_PATH", os.path.expanduser("~/.seen-titles"))
LEGACY_SEEN_TITLES_PATH = os.path.join(QUEUE_DIR, ".seen-titles")

DUP_THRESHOLD = 0.85
USER_AGENT = "Matcha/1.0 (research digest)"
FETCH_TIMEOUT = 15
FETCH_DELAY_SECONDS = 0.5
FETCH_MIN_CHARS = 200
FETCH_ABSTRACT_THRESHOLD = 200
MIN_QUEUE_TEXT_CHARS = 200
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
    existing = []
    for directory in (Path(QUEUE_DIR), Path(SKIP_DIR)):
        if directory.is_dir():
            existing.extend(int(f.stem) for f in directory.glob("*.md") if f.stem.isdigit())
    return max(existing, default=0) + 1


def get_queued_titles() -> list:
    """Load titles of already-queued or fetch-skipped articles for dedup."""
    titles = set()
    for seen_path in (Path(SEEN_TITLES_PATH), Path(LEGACY_SEEN_TITLES_PATH)):
        if seen_path.is_file():
            for line in seen_path.read_text(encoding="utf-8", errors="replace").splitlines():
                title = line.strip()
                if title:
                    titles.add(title)
    for directory in (Path(QUEUE_DIR), Path(SKIP_DIR)):
        if not directory.is_dir():
            continue
        for f in directory.glob("*.md"):
            text = f.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"^title:\s*(.+)$", text, re.MULTILINE)
            if m:
                titles.add(m.group(1).lower().strip())
    return sorted(titles)


def remember_titles(titles: list) -> None:
    """Persist seen titles so processed/deleted queue files are not recreated."""
    normalized = sorted({title.lower().strip() for title in titles if title and title.strip()})
    Path(SEEN_TITLES_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(SEEN_TITLES_PATH).write_text("\n".join(normalized) + ("\n" if normalized else ""), encoding="utf-8")


def is_duplicate(title: str, existing: list) -> bool:
    title_lower = title.lower().strip()
    return any(SequenceMatcher(None, title_lower, t).ratio() > DUP_THRESHOLD for t in existing)


def mark_seen(title: str, queued_titles: list) -> None:
    normalized = title.lower().strip()
    if normalized:
        queued_titles.append(normalized)
        remember_titles(queued_titles)


def substantive_text(article: dict) -> str:
    return normalize_text("\n\n".join(
        part for part in (
            article.get("abstract", ""),
            article.get("content", ""),
        )
        if part
    ))


def should_skip_without_queue(article: dict) -> tuple[bool, str]:
    """Return whether an article is too thin to spend librarian cycles on."""
    text_len = len(substantive_text(article))
    title = article.get("title", "")
    source = article.get("source", "")
    batch = article.get("batch", "")

    if re.search(r"\b(author correction|correction:|erratum|addendum)\b", title, re.I):
        return True, "correction/erratum/addendum"
    if source.upper() == "DOAJ" or re.search(r"\bDOAJ\b|ISSN|\(\d{4}-\d{3}[\dXx]", f"{title} {batch}"):
        return True, "journal/table-of-contents metadata"
    if text_len < MIN_QUEUE_TEXT_CHARS:
        return True, f"insufficient article text ({text_len} chars)"
    return False, ""


def record_skip(num: int, article: dict, reason: str) -> str:
    article = {**article, "abstract": article.get("abstract", "").strip()}
    article["skip_reason"] = reason
    article["content"] = f"Skipped at split time: {reason}"
    return write_queue_file(num, article, directory=SKIP_DIR)


def archive_inbox_file(inbox_file: Path) -> Path:
    """Move a split inbox file out of the active inbox so it is not reprocessed."""
    Path(ARCHIVE_DIR).mkdir(parents=True, exist_ok=True)
    destination = Path(ARCHIVE_DIR) / inbox_file.name
    if destination.exists():
        stamp = datetime.now().strftime("%H%M%S")
        destination = Path(ARCHIVE_DIR) / f"{inbox_file.stem}-{stamp}{inbox_file.suffix}"
    shutil.move(str(inbox_file), str(destination))
    return destination


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
        # Fallback: use body but strip nav, footer, header, aside, form
        body = soup.body or soup
        for tag in body(["nav", "footer", "header", "aside", "form", "iframe"]):
            tag.decompose()
        candidates = [body]

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
    if article.get('skip_reason'):
        content += f"\n**Skipped at split time:** {article['skip_reason']}\n"
    if article.get('content') and len(article.get('content', '')) >= FETCH_MIN_CHARS:
        content += f"\n{article['content']}\n"
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
        m = re.match(r'^- \[([^\]]+)\]\(([^)]*)\)\s*\*\(([^)]*)\)\*\s*(.*)?$', stripped)
        if not m:
            # Try without source tag: - [Title](url)
            m = re.match(r'^- \[([^\]]+)\]\(([^)]*)\)\s*(.*)?$', stripped)
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
    os.makedirs(SKIP_DIR, exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)

    queued_titles = get_queued_titles()
    remember_titles(queued_titles)
    log(f"Already queued: {len(queued_titles)} articles")

    inbox_files = sorted(Path(INBOX_DIR).glob("*-articles.md"))
    if not inbox_files:
        log("No inbox files found. Nothing to split.")
        return 0

    total_new = 0
    total_skipped = 0
    total_archived = 0
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
                if len(fetched) >= FETCH_MIN_CHARS:
                    article["content"] = fetched

            should_skip, reason = should_skip_without_queue(article)
            if should_skip:
                path = record_skip(next_num, article, reason)
                log(f"Skipped {reason}: {article['title']} -> {path}")
                mark_seen(article["title"], queued_titles)
                next_num += 1
                total_skipped += 1
                continue

            path = write_queue_file(next_num, article)
            log(f"Queued {article['title']} -> {path}")
            mark_seen(article["title"], queued_titles)
            next_num += 1
            total_new += 1

        archived = archive_inbox_file(inbox_file)
        total_archived += 1
        log(f"Archived split inbox file -> {archived}")

    log(f"Done: {total_new} new queue files, {total_skipped} skipped (dups/already seen/thin), {total_archived} inbox files archived")
    return 0


if __name__ == "__main__":
    sys.exit(main())

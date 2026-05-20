#!/usr/bin/env python3
"""arxiv_trickle.py — Continuous arXiv trickle scraper.

Runs as a background process, cycling through arXiv queries with 3-5s
between requests to stay under rate limits. New articles are appended
to VAULT_DIR/raw/inbox/YYYY-MM-DD-articles.md in the same format as
filter_matcha.py, so the librarian picks them up naturally.

Usage:
    python3 arxiv_trickle.py            # foreground
    nohup python3 arxiv_trickle.py &     # background daemon

Environment:
    VAULT_DIR   Path to vault (default: ~/vault)
"""
import os
import sys
import time
import random
import xml.etree.ElementTree as ET
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────

VAULT_DIR = os.environ.get("VAULT_DIR", os.path.expanduser("~/vault"))
INBOX_DIR = os.path.join(VAULT_DIR, "raw", "inbox")

# Category-based queries — robust against arXiv's strict query parser.
# Plain free-text queries (e.g. "large language models transformer") return HTTP 400.
ARXIV_QUERIES = [
    ("cat:cs.AI", "AI/ML"),
    ("cat:cs.LG", "AI/ML"),
    ("cat:cs.CL", "AI/ML"),
    ("cat:cs.CV", "AI/ML"),
    ("cat:cs.RO", "Robotics"),
    ("cat:cs.CR", "Cybersecurity"),
    ("cat:quant-ph", "Physics"),
    ("cat:astro-ph.IM", "Space/Aerospace"),
]

RESULTS_PER_QUERY = 20       # max_results per arXiv query
MIN_DELAY = 3.0              # arXiv requires >= 3s between requests
MAX_DELAY = 5.0              # random jitter to stay under limits
CHECK_INTERVAL = 600         # how long between status log messages (10 min)
LOCK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arxiv_trickle.lock")

# ── State ──────────────────────────────────────────────────────────────────

seen_urls = set()            # session-level dedup
total_fetched = 0
total_written = 0
cycle_count = 0


def log(msg):
    """Print timestamped log message."""
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def acquire_lock():
    """Prevent multiple instances from running."""
    lock_path = Path(LOCK_FILE)
    if lock_path.exists():
        try:
            pid = int(lock_path.read_text().strip())
            os.kill(pid, 0)  # check if process is alive
            log(f"Another instance is running (PID {pid}). Exiting.")
            sys.exit(0)
        except (ValueError, ProcessLookupError, OSError):
            pass  # stale lock, continue
    lock_path.write_text(str(os.getpid()))


def release_lock():
    """Remove lock file on exit."""
    lock_path = Path(LOCK_FILE)
    try:
        lock_path.unlink(missing_ok=True)
    except OSError:
        pass


def fetch_arxiv(query, max_results=20):
    """Fetch articles from arXiv API, sorted by submission date (newest first).
    Returns list of article dicts.
    """
    # `safe=':+'` keeps category prefixes (cat:cs.AI) and boolean joins (+AND+) intact;
    # `urllib.parse.quote` would otherwise percent-encode `:` and break arXiv's parser.
    url = (f"http://export.arxiv.org/api/query?"
           f"search_query={urllib.parse.quote(query, safe=':+')}"
           f"&start=0&max_results={max_results}"
           f"&sortBy=submittedDate&sortOrder=descending")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ChiyaLibrary/1.0"})
        resp = urllib.request.urlopen(req, timeout=15)
        raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 429:
            log("  ⏳ Rate limited (429), waiting 10s...")
            time.sleep(10)
        else:
            log(f"  ⚠️ HTTP {e.code} for query '{query}': {e.reason}")
        return []
    except Exception as e:
        log(f"  ⚠️ Request failed for '{query}': {e}")
        return []

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        log(f"  ⚠️ XML parse error for '{query}': {e}")
        return []

    ns = {"atom": "http://www.w3.org/2005/Atom"}
    articles = []

    for entry in root.findall("atom:entry", ns):
        title_el = entry.find("atom:title", ns)
        summary_el = entry.find("atom:summary", ns)
        published_el = entry.find("atom:published", ns)
        id_el = entry.find("atom:id", ns)

        if title_el is not None and id_el is not None:
            title = (title_el.text or "").strip().replace("\n", " ")[:200]
            abstract = (summary_el.text or "").strip() if summary_el is not None else ""
            pub = (published_el.text or "")[:10] if published_el is not None else ""
            arxiv_id = (id_el.text or "").strip()
            url = f"https://arxiv.org/abs/{arxiv_id.split('/')[-1]}" if arxiv_id else ""

            articles.append({
                "title": title,
                "abstract": abstract,
                "url": url,
                "date": pub,
                "source": "arXiv",
                "domain": "arxiv",
                "abstract_short": abstract[:200],
            })

    return articles


def _format_line(art):
    """Match the parser regex in pipelines/src/shared/article.ts:
    - [title](url) *(source)* — snippet
    """
    title = art["title"].replace("[", "(").replace("]", ")")
    snippet = (art.get("abstract_short") or "").replace("\n", " ").strip()
    suffix = f" — {snippet}" if snippet else ""
    return f"- [{title}]({art['url']}) *({art['source']})*{suffix}"


def write_to_inbox(articles, field):
    """Append articles to VAULT_DIR/raw/inbox/YYYY-MM-DD-articles.md.
    Articles should be pre-filtered for dedup before calling.
    Emits the same shape filter_matcha.py does (frontmatter + #### field +
    `- [title](url) *(source)* — snippet`) so the librarian's parser picks it up.
    Returns count of articles written.
    """
    if not articles:
        return 0

    today = datetime.now().strftime("%Y-%m-%d")
    inbox_path = os.path.join(INBOX_DIR, f"{today}-articles.md")

    os.makedirs(INBOX_DIR, exist_ok=True)
    is_new = not os.path.exists(inbox_path)

    with open(inbox_path, "a", encoding="utf-8") as f:
        if is_new:
            f.write("---\n")
            f.write("source: arxiv-trickle\n")
            f.write(f"clipped: {datetime.now().isoformat()}\n")
            f.write("contributor: scheduled:arxiv-trickle\n")
            f.write("type: article\n")
            f.write("tags: [auto-collected, research, arxiv-trickle]\n")
            f.write("---\n\n")
            f.write(f"# Raw Articles — {today}\n\n")
            f.write("> Auto-collected from arXiv trickle scraper. Deduplicated. Awaiting ingest.\n\n")

        f.write("---\n")
        f.write(f"### Trickle scraped at {datetime.now().strftime('%H:%M')} — arXiv\n")
        f.write(f"### {len(articles)} new articles\n\n")
        f.write(f"#### {field}\n")
        for a in articles:
            seen_urls.add(a["url"].lower())
            f.write(_format_line(a) + "\n")
        f.write("\n")

    return len(articles)


def main():
    acquire_lock()
    global total_fetched, total_written, cycle_count

    log(f"arXiv Trickle Scraper started (PID {os.getpid()})")
    log(f"Queries: {len(ARXIV_QUERIES)}, Results/query: {RESULTS_PER_QUERY}")
    log(f"Delay: {MIN_DELAY}-{MAX_DELAY}s between requests")
    log(f"Writing to: {INBOX_DIR}")

    try:
        while True:
            cycle_start = time.time()
            new_this_cycle = 0

            for query, field in ARXIV_QUERIES:
                # Random delay before each request (arXiv rate limit)
                delay = random.uniform(MIN_DELAY, MAX_DELAY)
                time.sleep(delay)

                articles = fetch_arxiv(query, RESULTS_PER_QUERY)
                total_fetched += len(articles)

                # Filter out already-seen
                new_articles = [a for a in articles if a["url"].lower() not in seen_urls]
                seen_urls.update(a["url"].lower() for a in articles)

                if new_articles:
                    written = write_to_inbox(new_articles, field)
                    total_written += written
                    new_this_cycle += written

            cycle_count += 1
            cycle_elapsed = time.time() - cycle_start

            # Log status periodically
            if cycle_count % 6 == 1 or new_this_cycle > 0:
                log(f"Cycle {cycle_count}: fetched {total_fetched}, "
                    f"new={total_written}, "
                    f"this_cycle={new_this_cycle}, "
                    f"elapsed={cycle_elapsed:.0f}s")

            # Small pause between cycles
            time.sleep(random.uniform(5, 10))

    except KeyboardInterrupt:
        log("\nShutting down...")
    finally:
        log(f"Stats: {total_fetched} fetched, {total_written} new written, {cycle_count} cycles")
        release_lock()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""filter_matcha.py - Merge and deduplicate RSS + API articles for VAULT_DIR/raw/inbox/YYYY-MM-DD-articles.md

Only deduplicates. Scoring/curating is handled by the agent during curation.
Writes to VAULT_DIR/raw/inbox/ (vault ingest drop zone) so the scheduled ingest sweep
picks it up automatically. The ingest moves it to raw/ after integration.

VAULT_DIR env var points to the target vault (default: ~/vault).
"""
import os
import re
import json
from datetime import datetime
from collections import defaultdict
from difflib import SequenceMatcher
from urllib.parse import urlsplit, urlunsplit

# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MATCHA_DIR = os.path.dirname(SCRIPT_DIR)
VAULT_DIR = os.environ.get("VAULT_DIR", os.path.expanduser("~/vault"))
TODAY = datetime.now().strftime("%Y-%m-%d")

# Inputs
RAW_DIGEST_PATH = os.path.join(MATCHA_DIR, "output", f"matcha-digest-{TODAY}.md")
API_ARTICLES_PATH = os.path.join(SCRIPT_DIR, "api-articles.jsonl")

# Output — vault raw/inbox/ (ingest drop zone)
RAW_INBOX_DIR = os.path.join(VAULT_DIR, "raw", "inbox")
RAW_ARTICLES_PATH = os.path.join(RAW_INBOX_DIR, f"{TODAY}-articles.md")
RAW_ARCHIVE_DIR = os.path.join(RAW_INBOX_DIR, "archive")
DUP_THRESHOLD = 0.85
MIN_API_ABSTRACT_CHARS = int(os.environ.get("MIN_API_ABSTRACT_CHARS", "80"))
MAX_ABSTRACT_CHARS = int(os.environ.get("MAX_ARTICLE_ABSTRACT_CHARS", "1200"))
DISABLED_SECTIONS = {
    "DOAJ (Open Access aggregator)",
    "Al Jazeera",
}
LOW_VALUE_RSS_SECTIONS = {
    "Hacker News Front Page",
    "Hacker News Best",
    "The Verge",
}


def normalize_title(title):
    """Normalize titles for fuzzy duplicate checks."""
    title = re.sub(r'<[^>]+>', '', title or '')
    title = re.sub(r'\s+', ' ', title).strip().lower()
    title = re.sub(r'^[^\w]+|[^\w]+$', '', title)
    return title


def normalize_url(url):
    """Normalize URLs enough to catch repeated feed/API entries."""
    if not url:
        return ''
    url = str(url)
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    netloc = parts.netloc.lower()
    path = parts.path.rstrip('/')
    return urlunsplit((parts.scheme.lower(), netloc, path, '', ''))


def article_quality(article):
    """Prefer duplicates that carry usable abstract text."""
    return len((article.get('abstract') or '').strip())


def load_api_articles(api_path):
    """Load API articles from JSONL output of api_ingest.py"""
    articles = []
    if not os.path.exists(api_path):
        print(f"  ⚠️  API articles not found: {api_path}")
        return articles
    with open(api_path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    articles.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return articles


def parse_rss_articles(rss_path):
    """Parse matcha's markdown RSS digest into article dicts."""
    articles = []
    if not os.path.exists(rss_path):
        print(f"  ⚠️  RSS digest not found: {rss_path}")
        return articles

    with open(rss_path) as f:
        content = f.read()

    current_section = None

    for line in content.split('\n'):
        # Detect section headers
        if line.startswith('### '):
            match = re.match(r'### (.+)', line)
            if match:
                current_section = re.sub(r'<.*?>', '', match.group(1)).strip().split('\n')[0]
        # Detect article links [title](url)
        elif current_section:
            match = re.search(r'\[([^\]]+)\]\(([^)]+)\)', line)
            if match:
                title_raw = match.group(1).strip()
                url = match.group(2).strip()
                if not title_raw or title_raw in ['💬', '🔥', '_']:
                    continue
                # Clean icon prefixes
                clean_title = re.sub(r'^([^\w\s]+[\s]*)+', '', title_raw).strip()
                if not clean_title:
                    clean_title = title_raw
                articles.append({
                    'title': clean_title,
                    'url': url,
                    'section': current_section,
                    'source': 'RSS',
                    'abstract': ''
                })
    return articles


def deduplicate(articles):
    """Deduplicate articles by normalized URL and title similarity."""
    unique = []
    for article in articles:
        title_norm = normalize_title(article.get('title', ''))
        url_norm = normalize_url(article.get('url', ''))
        if not title_norm:
            continue
        dup_index = None
        for i, existing in enumerate(unique):
            existing_title = normalize_title(existing.get('title', ''))
            existing_url = normalize_url(existing.get('url', ''))
            same_url = url_norm and existing_url and url_norm == existing_url
            same_title = SequenceMatcher(None, title_norm, existing_title).ratio() > DUP_THRESHOLD
            if same_url or same_title:
                dup_index = i
                break
        if dup_index is None:
            unique.append(article)
        elif article_quality(article) > article_quality(unique[dup_index]):
            unique[dup_index] = article
    return unique


def existing_article_paths(path):
    """Return active and archived article files for cross-day dedup.

    ArticleStore is the long-term dedup source of truth after intake, but the
    collector should still avoid appending old articles when the DB has been
    reset or intake has not run yet. Check the active daily file plus every
    archived raw inbox article file, not only archives with today's date prefix.
    """
    paths = []
    if os.path.exists(path):
        paths.append(path)
    if os.path.isdir(RAW_ARCHIVE_DIR):
        for name in sorted(os.listdir(RAW_ARCHIVE_DIR)):
            if name.endswith("-articles.md"):
                paths.append(os.path.join(RAW_ARCHIVE_DIR, name))
    return paths


def get_existing_articles(paths):
    """Read existing title and URL keys from active/archived raw article files."""
    titles = []
    urls = set()
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for line in f:
                match = re.search(r'\[([^\]]+)\]\(([^)]*)\)', line)
                if match:
                    titles.append(normalize_title(match.group(1)))
                    urls.add(normalize_url(match.group(2)))
    return titles, urls


def already_seen(article, existing_titles, existing_urls):
    """Return True when an article is already present in today's file."""
    title_norm = normalize_title(article.get('title', ''))
    url_norm = normalize_url(article.get('url', ''))
    if url_norm and url_norm in existing_urls:
        return True
    return any(SequenceMatcher(None, title_norm, title).ratio() > DUP_THRESHOLD for title in existing_titles)


def candidate_reason(article):
    """Return None for keep, otherwise the reason this article should be dropped."""
    title = article.get('title', '')
    section = article.get('section', article.get('domain', article.get('source', '')))
    source = article.get('source', '')
    abstract = (article.get('abstract') or '').strip()

    if not title or title in ['💬', '🔥', '_']:
        return "missing title"
    if not article.get('url'):
        return "missing URL"
    if section in DISABLED_SECTIONS or source == "DOAJ":
        return "disabled low-signal source"
    if section in LOW_VALUE_RSS_SECTIONS:
        return "low-value broad RSS section"
    if re.search(r'\b(author correction|correction:|erratum|addendum)\b', title, re.I):
        return "correction/erratum/addendum"
    if source != "RSS" and len(abstract) < MIN_API_ABSTRACT_CHARS:
        return f"API article has short/no abstract ({len(abstract)} chars)"
    return None


def filter_candidates(articles):
    """Remove entries that consistently become queue stubs or librarian skips."""
    kept = []
    dropped = defaultdict(int)
    for article in articles:
        reason = candidate_reason(article)
        if reason is None:
            kept.append(article)
        else:
            dropped[reason] += 1
    return kept, dropped


def format_article_line(art):
    """Format a single article as a markdown line."""
    source_tag = f" *({art.get('source', 'RSS')})*"
    abstract = art.get('abstract', '') or ''
    abstract = re.sub(r'\s+', ' ', abstract).strip()
    abstract_preview = f" — {abstract[:MAX_ABSTRACT_CHARS]}" if abstract else ''
    return f"- [{art['title']}]({art['url']}){source_tag}{abstract_preview}"


def main():
    print(f"🍵 Matcha dedup — {TODAY}")
    print(f"{'='*50}")

    # Load articles
    print("Loading RSS articles...")
    rss_articles = parse_rss_articles(RAW_DIGEST_PATH)
    print(f"  → {len(rss_articles)} RSS articles")

    print("Loading API articles...")
    api_articles = load_api_articles(API_ARTICLES_PATH)
    print(f"  → {len(api_articles)} API articles")

    # Merge
    all_articles = rss_articles + api_articles
    print(f"  → {len(all_articles)} total before dedup")

    all_articles, dropped = filter_candidates(all_articles)
    print(f"  → {len(all_articles)} after quality/source filters")
    for reason, count in sorted(dropped.items()):
        print(f"    - dropped {count}: {reason}")

    # Deduplicate within this batch
    batch_unique = deduplicate(all_articles)
    print(f"  → {len(batch_unique)} after dedup")

    # Check what's already in the daily file
    existing_paths = existing_article_paths(RAW_ARTICLES_PATH)
    existing_titles, existing_urls = get_existing_articles(existing_paths)
    if existing_paths:
        print(f"  → checked {len(existing_paths)} active/archived daily files for existing articles")
    new_articles = []
    for art in batch_unique:
        if not already_seen(art, existing_titles, existing_urls):
            new_articles.append(art)

    already_seen_count = len(batch_unique) - len(new_articles)
    print(f"  → {len(new_articles)} new articles ({already_seen_count} already in today's file)")

    if not new_articles:
        print("\n✅ Nothing new to add.")
        return

    # Append to daily raw articles file in vault inbox
    os.makedirs(RAW_INBOX_DIR, exist_ok=True)
    file_is_new = not os.path.exists(RAW_ARTICLES_PATH)

    with open(RAW_ARTICLES_PATH, 'a') as f:
        if file_is_new:
            # Write header with vault-contributor frontmatter
            f.write("---\n")
            f.write("source: matcha-pipeline\n")
            f.write(f"clipped: {datetime.now().isoformat()}\n")
            f.write("contributor: scheduled:rss-feed\n")
            f.write("type: article\n")
            f.write("tags: [auto-collected, research]\n")
            f.write("---\n\n")
            f.write(f"# Raw Articles — {TODAY}\n\n")
            f.write("> Auto-collected from matcha RSS + API pipeline. Deduplicated. Awaiting ingest.\n\n")

        # Get sections from new articles for grouping
        by_section = defaultdict(list)
        for art in new_articles:
            sec = art.get('section', art.get('domain', art.get('source', 'Other')))
            by_section[sec].append(art)

        f.write("---\n")
        f.write(f"### Collected at {datetime.now().strftime('%H:%M')}\n")
        f.write(f"### {len(new_articles)} new articles\n\n")

        for section, arts in by_section.items():
            f.write(f"#### {section}\n")
            for art in arts:
                f.write(format_article_line(art) + "\n")
            f.write("\n")

    print(f"\n✅ Appended {len(new_articles)} articles to {RAW_ARTICLES_PATH}")


if __name__ == "__main__":
    main()

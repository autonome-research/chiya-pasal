#!/usr/bin/env python3
"""filter_matcha.py - Merge and deduplicate RSS + API articles for wiki/raw/articles/YYYY-MM-DD.md

Only deduplicates. Scoring/curating is handled by the agent during curation.
Appends new articles to the daily raw intake file (accumulates all day).
"""
import os
import re
import sys
import json
from datetime import datetime
from collections import defaultdict
from difflib import SequenceMatcher

# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MATCHA_DIR = os.path.dirname(SCRIPT_DIR)
TODAY = datetime.now().strftime("%Y-%m-%d")

# Inputs
RAW_DIGEST_PATH = os.path.join(MATCHA_DIR, "output", f"matcha-digest-{TODAY}.md")
API_ARTICLES_PATH = os.path.join(SCRIPT_DIR, "api-articles.jsonl")

# Output — wiki raw articles (accumulates all day)
RAW_ARTICLES_DIR = os.path.expanduser("~/wiki/raw/articles")
RAW_ARTICLES_PATH = os.path.join(RAW_ARTICLES_DIR, f"{TODAY}.md")


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
    """Deduplicate articles by title similarity (>0.85 = duplicate)."""
    unique = []
    for article in articles:
        title_lower = article['title'].lower().strip()
        is_dup = False
        for existing in unique:
            existing_title = existing['title'].lower().strip()
            if SequenceMatcher(None, title_lower, existing_title).ratio() > 0.85:
                is_dup = True
                break
        if not is_dup:
            unique.append(article)
    return unique


def get_existing_titles(path):
    """Read existing titles from the daily raw articles file (to avoid re-adding)."""
    titles = set()
    if not os.path.exists(path):
        return titles
    with open(path) as f:
        for line in f:
            match = re.search(r'\[([^\]]+)\]\(([^)]+)\)', line)
            if match:
                titles.add(match.group(1).lower().strip())
    return titles


def format_article_line(art):
    """Format a single article as a markdown line."""
    source_tag = f" *({art.get('source', 'RSS')})*"
    abstract = art.get('abstract', '') or ''
    abstract_preview = ' — ' + abstract[:150] + '...' if len(abstract) > 150 else f" — {abstract}" if abstract else ''
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

    # Deduplicate within this batch
    batch_unique = deduplicate(all_articles)
    print(f"  → {len(batch_unique)} after dedup")

    # Check what's already in the daily file
    existing_titles = get_existing_titles(RAW_ARTICLES_PATH)
    new_articles = []
    for art in batch_unique:
        if art['title'].lower().strip() not in existing_titles:
            new_articles.append(art)

    already_seen = len(batch_unique) - len(new_articles)
    print(f"  → {len(new_articles)} new articles ({already_seen} already in today's file)")

    if not new_articles:
        print("\n✅ Nothing new to add.")
        return

    # Append to daily raw articles file
    os.makedirs(RAW_ARTICLES_DIR, exist_ok=True)
    file_is_new = not os.path.exists(RAW_ARTICLES_PATH)

    with open(RAW_ARTICLES_PATH, 'a') as f:
        if file_is_new:
            # Write header for new file
            f.write(f"# Raw Articles — {TODAY}\n\n")
            f.write(f"> Auto-collected from matcha RSS + API pipeline. Deduplicated. Not yet curated.\n\n")

        # Get sections from new articles for grouping
        by_section = defaultdict(list)
        for art in new_articles:
            sec = art.get('section', art.get('domain', art.get('source', 'Other')))
            by_section[sec].append(art)

        f.write(f"---\n")
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

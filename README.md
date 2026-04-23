# Chiya Library 🍵

A persistent, interlinked knowledge base powered by automated collection, agent-driven curation, and Karpathy-style wiki architecture.

Chiya (茶) — "tea" — a curated serving of research intelligence, delivered daily.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Collection Layer                         │
│                                                             │
│  Linux cron (every 4h) → collect.sh                        │
│    ├── api_ingest.py    → 8 API sources (Semantic Scholar,  │
│    │                     OpenAlex, arXiv, etc.)             │
│    ├── matcha binary    → ~30 RSS feeds (Nature, HN, labs) │
│    └── filter_matcha.py → dedup → wiki/raw/articles/        │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Curation Layer                           │
│                                                             │
│  Hermes cron (daily 6:30 PM PT) → Agent session            │
│    ├── Librarian: ingest articles → wiki pages              │
│    │                   cross-reference → index + log        │
│    └── Digest Agent: curate → deliver to Discord           │
└─────────────────────────────────────────────────────────────┘
```

## Repository Structure

```
chiya-library/
├── README.md                    # This file
├── wiki/                        # The knowledge base
│   ├── SCHEMA.md                # Conventions, tags, structure
│   ├── TASTE.md                 # User preferences (manual)
│   ├── index.md                 # Content catalog
│   ├── log.md                   # Action log (append-only)
│   ├── raw/articles/            # Daily intake: YYYY-MM-DD.md
│   ├── raw/assets/              # Images, diagrams
│   ├── entities/                # People, orgs, products
│   ├── topics/                  # Knowledge by sub-field
│   │   ├── ai-ml/
│   │   ├── computing/
│   │   ├── robotics/
│   │   ├── neuroscience/
│   │   ├── physics/
│   │   ├── biology/
│   │   ├── materials/
│   │   ├── energy/
│   │   └── cybersecurity/
│   ├── user/                    # User profile & focuses
│   │   ├── profile.md
│   │   ├── interests.md
│   │   └── focuses/             # Current priorities → digest signal
│   ├── research/                # Active projects
│   │   └── <project>/           # One sub-dir per project
│   │       ├── STATUS.md        # Current state + last updated
│   │       └── notes.md
│   └── _archive/                # Superseded pages
├── matcha/                      # Collection pipeline
│   ├── config.yaml              # Feed URLs, limits, keywords
│   ├── interests.yaml           # Interest keywords
│   ├── scripts/
│   │   ├── api_ingest.py        # API-only sources
│   │   ├── filter_matcha.py     # Dedup only
│   │   └── collect.sh           # Orchestrator script
│   └── logs/                    # Collection logs
├── agents/                      # Agent prompts
│   ├── librarian/
│   │   └── prompt.md            # Wiki ingestion workflow
│   └── chiya-digest/
│       └── prompt.md            # Digest curation workflow
└── cron/                        # Cron configuration docs
    └── README.md
```

## Quick Start

### Prerequisites
- Python 3.8+
- Go 1.21+ (to build matcha binary)
- Git

### Setup

```bash
# 1. Clone the repo
git clone git@github.com:Code4me2/chiya-library.git
cd chiya-library

# 2. Build matcha binary (if not already built)
cd matcha
# (copy matcha source or build from https://github.com/Code4me2/matcha)
cp /path/to/matcha/bin/matcha bin/

# 3. Configure feeds
cp matcha/config.yaml.example matcha/config.yaml  # edit feeds
cp matcha/interests.yaml.example matcha/interests.yaml  # edit keywords

# 4. Set up Linux cron (collection every 4h)
crontab -e
# Add: 0 */4 * * * /path/to/chiya-library/matcha/scripts/collect.sh >> /path/to/chiya-library/matcha/logs/cron.log 2>&1

# 5. Set up TASTE.md
# Edit wiki/TASTE.md with your preferences

# 6. Set up user context
# Edit wiki/user/profile.md, interests.md
# Create wiki/user/focuses/<focus>.md for current priorities
```

### Cron Jobs

**Collection** (Linux cron, every 4h):
- Mechanical — runs `api_ingest.py` → `matcha` → `filter_matcha.py` → appends to `wiki/raw/articles/YYYY-MM-DD.md`

**Curation** (Hermes cron, daily 6:30 PM PT):
- Agent-driven — librarian ingests into wiki, digest agent curates and delivers

See `cron/README.md` for details.

## Sources

- **RSS feeds:** arXiv (cs.AI, cs.LG, cs.CV, cs.RO, etc.), Nature, Science, Hacker News, DeepMind/OpenAI/Anthropic blogs, tech news
- **API sources:** Semantic Scholar, OpenAlex, CrossRef, arXiv API, Europe PMC, INSPIRE-HEP, Zenodo, DOAJ

## License

MIT

# Chiya Library 🍵

A persistent, interlinked knowledge base powered by automated collection, agent-driven curation, and wiki-style cross-referencing.

Chiya (茶) — "tea" — a curated serving of research intelligence, delivered daily.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Collection                                                  │
│                                                              │
│  Linux cron (every 4h) → matcha/scripts/collect.sh           │
│    ├── TS API ingest     → source adapters (Semantic Scholar,│
│    │                       OpenAlex, CrossRef, arXiv, legacy │
│    │                       academic APIs)                    │
│    ├── matcha binary     → ~30 RSS feeds                     │
│    └── filter_matcha.py  → dedup → vault/raw/inbox/*.md      │
└──────────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────────┐
│  Pipelines (TypeScript on thread-phase, systemd user timers) │
│                                                              │
│  chiya-daily.timer (09:00 local, Persistent catch-up)         │
│    └── run-cycle.sh: collect → intake → librarian drain      │
│        → graph/log git push → one guarded daily digest email  │
│                                                              │
│  Individual intake/librarian/digest units remain available   │
│  for manual debugging and advanced split-cadence operation.  │
└──────────────────────────────────────────────────────────────┘
```

Two SQLite tables anchor the flow: `article` (status FSM: pending → processing → done/skipped/failed) and `job` (thread-phase's persisted run log). Both live in `<vault>/.chiya-pipelines.db`.

## Repository Structure

```
chiya-library/
├── README.md                    # This file
├── matcha/                      # Collection orchestration (shell + Go RSS reader)
│   ├── config.yaml              # Feed URLs, limits, keywords
│   ├── interests.yaml           # Interest keywords
│   ├── scripts/
│   │   ├── collect.sh           # Calls TS API ingest + RSS + filter
│   │   ├── filter_matcha.py     # Dedup + interest filter
│   │   └── api_ingest.py        # Legacy Python API collector (not live)
│   └── logs/                    # Collection logs
└── pipelines/                   # Curation layer (TS, thread-phase)
    ├── src/
    │   ├── intake.ts            # Pipeline entry points
    │   ├── librarian.ts
    │   ├── digest.ts
    │   ├── phases/              # Phase compositions
    │   │   ├── intake-phases.ts
    │   │   ├── librarian-phases.ts
    │   │   ├── librarian-planner.ts
    │   │   ├── librarian-apply.ts
    │   │   ├── librarian-router.ts
    │   │   ├── scouts/          # 4 parallel exploration scouts
    │   │   ├── reviewer.ts
    │   │   ├── summary.ts
    │   │   ├── digest-phases.ts
    │   │   ├── digest/          # context/load/classify/draft/publish modules
    │   │   ├── page-templates.ts
    │   │   └── topic-reconciler.ts
    │   ├── shared/              # ArticleStore, env, types
    │   └── tools/               # vault / git / email / web / article-lookup
    ├── scripts/                 # One-shots (migrations, dumps)
    ├── systemd/                 # User timer/service units
    └── __tests__/               # Vitest suite (351 tests)
```

The wiki is a separate repo (`~/vault`) — not vendored here. Sources live at `wiki/sources/<stable-id>.md`, topics at `wiki/topics/<slug>.md` (flat, with `clusters:` frontmatter for soft domain metadata), entities at `wiki/entities/<slug>.md`. The append-only `log.md` and `index.md` sit at the vault root.

## Quick Start

### Prerequisites
- Node 20+
- Python 3.10+
- Go 1.21+ (to build the matcha binary)

### Setup

```bash
# 1. Clone
git clone git@github.com:autonome-research/chiya-pasal.git ~/chiya-library
cd ~/chiya-library

# 2. Pipelines
cd pipelines
npm install
npm run build

# 3. Matcha collector
cd ../matcha
cp /path/to/matcha/bin/matcha bin/
cp config.yaml.example config.yaml      # edit feeds
cp interests.yaml.example interests.yaml

# 4. Vault (separate repo, sibling of chiya-library by default)
git clone <your-vault-remote> ~/vault
# Edit ~/vault/TASTE.md, ~/vault/user/profile.md to taste

# 5. systemd timer (daily full cycle). See pipelines/README.md for install steps.
# The daily cycle calls matcha/scripts/collect.sh itself, so a separate cron
# collector is optional and not needed for the default once-daily workflow.
```

## Cadences

| Layer | Trigger | Frequency |
|---|---|---|
| daily full cycle | systemd timer | 09:00 local; `Persistent=true` catches up after boot/wake |

The daily cycle collects, dedupes, intakes, updates the vault graph, commits/pushes, and sends one guarded digest email. If the device is off at 09:00, systemd runs the missed cycle later the same day when the user session is active. The digest email is guarded so retries do not send duplicate mail for the same local calendar day.

## Sources

- **RSS feeds:** arXiv (cs.AI, cs.LG, cs.CV, cs.RO, …), Nature, Science, Hacker News, DeepMind/OpenAI/Anthropic blogs, lab feeds
- **APIs:** Semantic Scholar, OpenAlex, CrossRef, arXiv, Europe PMC, INSPIRE-HEP, Zenodo, DOAJ, NCBI/PubMed, OSF

## Pipeline detail

See `pipelines/README.md` for systemd install steps, the per-pipeline phase composition, and operational notes.

## License

MIT

# Chiya Library 🍵

A persistent, interlinked knowledge base powered by automated collection, agent-driven curation, and wiki-style cross-referencing.

Chiya (茶) — "tea" — a curated serving of research intelligence, delivered daily.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Collection (runs once, all users)                           │
│                                                              │
│  Linux cron (every 4h) → matcha/scripts/collect.sh           │
│    ├── TS API ingest     → source adapters (Semantic Scholar,│
│    │                       OpenAlex, CrossRef, arXiv, legacy │
│    │                       academic APIs)                    │
│    ├── matcha binary     → ~30 RSS feeds                     │
│    └── filter_matcha.py  → dedup → chiya-data/shared inbox   │
└──────────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────────┐
│  SHARED pipeline (every 30 min — once per article, not user) │
│    absorb inbox → shared cache (stable IDs, dedup)           │
│    enrich: arXiv HTML → direct → Unpaywall OA (pdftotext)    │
│    summarize: rich structured summary + quality assessment   │
│    route: embedding cosine-match OR broadcast (current mode) │
│      └── COPY into each matched user's ArticleStore          │
└──────────────────────────────────────────────────────────────┘
                            │  per enabled user in users.yaml
┌──────────────────────────────────────────────────────────────┐
│  PER-USER pipelines (multi-tenant, isolated per user)        │
│                                                              │
│  librarian.timer    (every 10 min)                           │
│    └── per article: router → 4 scouts → reviewer → plan      │
│         then serial apply emits source/topic/cite pages      │
│         into THAT USER's vault                               │
│                                                              │
│  digest@.service    (06:30 + 18:30, AM/PM)                   │
│    └── load → prioritize → draft → commit → push → email     │
│         to THAT USER's address                               │
└──────────────────────────────────────────────────────────────┘
```

State anchors: the shared cache (`~/chiya-data/shared/articles.db` —
article lifecycle FSM, routing telemetry, citation-demand ledger) and one
`article` + `job` SQLite pair per user (`~/chiya-data/users/<handle>/vault/.chiya-pipelines.db`).
Tenants are registered in `pipelines/config/users.yaml` and managed with
`npm run admin -- users <list|show|add|pause|resume|remove>`.

## Repository Structure

```
chiya-library/
├── README.md                    # This file
├── AGENTS.md                    # Project intent and guidance for future agents
├── CONTRIBUTING.md              # Verification and contribution mechanics
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
    └── __tests__/               # Vitest suite (373 tests)
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

# 5. matcha cron (collection every 4h)
crontab -e
# 0 */4 * * * /home/$USER/chiya-library/matcha/scripts/collect.sh >> /home/$USER/chiya-library/matcha/logs/cron.log 2>&1

# 6. Optional health check
cd pipelines && npm run doctor -- --no-network

# 7. systemd timers (curation). See pipelines/README.md for the install steps.
```

## Cadences

| Layer | Trigger | Frequency |
|---|---|---|
| matcha collect | Linux cron | every 4h at HH:00 |
| shared pipeline | systemd timer | every 30 min at :07/:37 |
| librarian (per user) | systemd timer | every 10 min |
| digest AM (per user) | systemd timer | 06:30 local |
| digest PM (per user) | systemd timer | 18:30 local |

The digest commits and pushes the vault on every successful run. All steady-state timers have `Persistent=true` so a single missed cycle catches up at the next tick.

## Sources

- **RSS feeds:** arXiv (cs.AI, cs.LG, cs.CV, cs.RO, …), Nature, Science, Hacker News, DeepMind/OpenAI/Anthropic blogs, lab feeds
- **APIs:** Semantic Scholar, OpenAlex, CrossRef, arXiv, Europe PMC, INSPIRE-HEP, Zenodo, DOAJ, NCBI/PubMed, OSF

## Pipeline detail

See `pipelines/README.md` for systemd install steps, the per-pipeline phase composition, and operational notes.

## License

MIT

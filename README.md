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
├── README.md                    # This file (public Quick Start)
├── LICENSE                      # MIT
├── AGENTS.md                    # Project intent and guidance for future agents
├── CONTRIBUTING.md              # Verification and contribution mechanics
├── matcha/                      # Collection orchestration (shell + RSS binary)
│   ├── config.yaml.example      # Public template — copy to config.yaml
│   ├── interests.yaml.example   # Public template — copy to interests.yaml
│   ├── config.yaml              # Feed URLs (placeholder paths, not a live machine)
│   ├── interests.yaml           # Interest keywords
│   ├── scripts/
│   │   ├── collect.sh           # Calls TS API ingest + RSS + filter
│   │   ├── filter_matcha.py     # Dedup + interest filter
│   │   └── api_ingest.py        # Legacy Python API collector (not live)
│   └── logs/                    # Collection logs
└── pipelines/                   # Curation layer (TS, thread-phase)
    ├── README.md               # Live-operator runbook (tiny-emerson, not public default)
    ├── src/
    │   ├── shared-pipeline.ts   # SHARED pipeline entry (absorb→enrich→summarize→route)
    │   ├── librarian.ts         # Per-user curation entry (multi-tenant loop)
    │   ├── digest.ts            # Per-user digest entry (multi-tenant loop)
    │   ├── admin.ts             # Tenant admin CLI (users.yaml)
    │   ├── doctor.ts            # Operational health checks
    │   ├── status.ts            # Article/job status CLI
    │   ├── intake.ts            # Legacy single-tenant intake (retired)
    │   ├── phases/              # Phase compositions
    │   │   ├── shared/          # absorb / enrich / summarize / route
    │   │   ├── librarian-phases.ts
    │   │   ├── librarian-planner.ts
    │   │   ├── librarian-apply.ts
    │   │   ├── librarian-router.ts
    │   │   ├── scouts/          # 4 parallel exploration scouts
    │   │   ├── reviewer.ts
    │   │   ├── digest/          # context/load/classify/draft/publish modules
    │   │   ├── page-templates.ts
    │   │   └── topic-reconciler.ts
    │   ├── shared/              # Stores (shared + per-user), env, routing, users, types
    │   ├── collection/          # TS API source adapters
    │   └── tools/               # vault / git / email / web / article-lookup
    ├── scripts/                 # One-shots (migrations, dumps)
    ├── systemd/                 # User timer/service units
    └── __tests__/               # Vitest suite (511 tests)
```

The wiki is a separate repo (`~/vault`) — not vendored here. Sources live at `wiki/sources/<stable-id>.md`, topics at `wiki/topics/<slug>.md` (flat, with `clusters:` frontmatter for soft domain metadata), entities at `wiki/entities/<slug>.md`. The append-only `log.md` and `index.md` sit at the vault root.

## Quick Start

This is the public setup path for a new clone. It does **not** assume the live Autonome Research machine (`tiny-emerson`, `--user velvet`, `chiya-tunnel-tiny.service`). That deployment is documented separately in [`pipelines/README.md`](pipelines/README.md) (operator runbook).

### Prerequisites
- Node 20+
- Python 3.10+ (PyYAML — see `matcha/requirements.txt`)
- A git remote for your vault (wiki repo, not this one)
- Optional: a `matcha` RSS binary. This repository does **not** vendor Go sources (`matcha/` has no `.go` files or `go.mod`), so there is no in-repo `go build`. `collect.sh` looks for `matcha/bin/matcha` (gitignored) and runs `bin/matcha -c config.yaml`. If that file is missing, RSS is skipped; TypeScript API ingest still runs.

### Setup

```bash
# 1. Clone
git clone https://github.com/autonome-research/chiya-pasal.git
cd chiya-pasal
# operators often check this out as ~/chiya-library; any local path is fine

# 2. Pipelines (TypeScript curation layer)
cd pipelines
npm install
npm run build
# Point FAST_INFERENCE_* and TOOLS_INFERENCE_* at YOUR OpenAI-compatible
# endpoint via pipelines/.env (gitignored). Do not use the tiny-emerson
# localhost:11435 defaults unless you are on that machine — see
# pipelines/README.md (operator runbook).

# 3. Matcha collector
cd ../matcha
mkdir -p bin output logs
python3 -m pip install -r requirements.txt
cp config.yaml.example config.yaml          # edit feeds
cp interests.yaml.example interests.yaml
# Set markdown_dir_path to this directory's output/ folder.
# collect.sh invokes the RSS binary from matcha/scripts, so an absolute
# path to matcha/output is safer than a relative one.
# database_file_path can stay ./matcha.db (gitignored).
#
# RSS binary: collect.sh runs
#   "$MATCHA_DIR/bin/matcha" -c "$MATCHA_DIR/config.yaml"
# There is no Go module in this repo to build. If you have a matcha RSS
# binary (invoked as `matcha -c config.yaml`), install it at bin/matcha.
# If it is absent, collect.sh skips RSS and still runs API ingest + filter.

# 4. Vault (separate repo, sibling of this checkout by default)
git clone <your-vault-remote> ~/vault
# Edit ~/vault/TASTE.md, ~/vault/user/profile.md to taste

# 5. matcha cron (collection every 4h) — uses $HOME, not a hardcoded operator account
crontab -e
# 0 */4 * * * "$HOME/chiya-pasal/matcha/scripts/collect.sh" >> "$HOME/chiya-pasal/matcha/logs/cron.log" 2>&1
# Adjust the checkout path if you cloned elsewhere (operators: ~/chiya-library).

# 6. Optional health check (no inference network)
cd ../pipelines && npm run doctor -- --no-network

# 7. systemd timers are the live-operator install, not required to build,
#    test, or run pipelines by hand. See pipelines/README.md (runbook).
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

- **Public / new clone:** this Quick Start, then `cd pipelines && npm run doctor -- --no-network`. Run pipelines by hand against your own inference endpoint.
- **Live operator runbook:** [`pipelines/README.md`](pipelines/README.md) — systemd units, tiny-emerson vllm tunnel, `--user velvet` one-shots. Do not treat that file as the default public path.

## License

MIT — see [LICENSE](LICENSE).

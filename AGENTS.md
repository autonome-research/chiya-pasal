# AGENTS.md — Chiya Library Orientation

This repository is Chiya Library: a safer, extensible research-intelligence pipeline that turns collected research signals into a persistent wiki-style knowledge base.

The project is not just a scraper or a digest generator. Its goal is to maintain a living research memory: collect candidate sources, let agents explore and recommend, then use deterministic TypeScript code to update a vault graph of source pages, topic pages, entity pages, citations, and digest logs.

## Core purpose

Chiya should provide a curated serving of research intelligence with three properties:

1. **Persistent memory** — research artifacts become durable wiki pages, not transient chat output.
2. **Interlinked context** — sources, topics, entities, references, and related work form a navigable graph.
3. **Operational safety** — automated agents can help with judgment, but deterministic code owns state changes.

## Most important design principle

> LLMs propose; deterministic code disposes.

Agents may:

- explore the vault with read-only tools
- classify, summarize, and recommend
- produce bounded structured outputs

TypeScript code must own:

- filesystem writes
- database status transitions
- git commits/pushes
- email delivery
- validation, idempotency, rollback, retries, and recovery

Do not move side effects into prompts or agent-controlled tool calls unless there has been an explicit design decision to do so.

## Current architecture in one page

```text
Collection (once, all users)
  matcha/scripts/collect.sh
    → TypeScript API source adapters
    → RSS via matcha
    → filter_matcha.py
    → chiya-data shared inbox *.md

Shared pipeline (once per article, not per user)
  absorb inbox → SharedArticleStore (stable IDs, dedup, query labels)
    → enrich (arXiv HTML → direct URL → Unpaywall OA; pdftotext for PDFs)
    → summarize (rich structured summary + quality assessment/gate)
    → route (embedding cosine-match, or broadcast while embeddings are down)
    → COPY into each matched user's ArticleStore

Librarian (per enabled user in config/users.yaml)
  that user's pending articles
    → router
    → topic/source/entity/citation scouts   (explore THAT USER's vault)
    → reviewer
    → semantic article plans
    → serial deterministic apply
    → wiki/sources, wiki/topics, wiki/entities backlinks
    → unresolved cites → External references + shared demand ledger

Digest (per enabled user)
  that user's ArticleStore + vault context
    → classify
    → draft sections
    → append log
    → commit/squash/push
    → email that user
```

Each user's vault is its own git repo at `~/chiya-data/users/<handle>/vault`
with its pipeline DB inside it; the shared layer's cache + job log live at
`~/chiya-data/shared/articles.db`. Tenants are registered in
`pipelines/config/users.yaml` (managed via `npm run admin`).

## Canonical live format decisions

- The live raw inbox remains **Markdown-first** for now.
- JSONL/SQLite staging may be considered later, but only with a migration rationale.
- The TypeScript source adapter layer is live for API ingestion, but `filter_matcha.py` still performs final dedup/filter/raw-inbox rendering.

When working on collection, preserve the existing live artifacts unless deliberately changing the collection contract:

```text
matcha/scripts/api-articles.jsonl
matcha/scripts/api-digest.md
~/chiya-data/shared/raw/inbox/*-articles.md   (the shared inbox — matcha runs with
                                               VAULT_DIR=~/chiya-data/shared so its
                                               $VAULT_DIR/raw/inbox output lands here)
```

## Safety mechanisms that should not be regressed

The project currently relies on these safety patterns:

- **Semantic planning + serial apply** in the librarian.
- **Source page written last** as an article completion marker.
- **Per-article rollback** during apply failures.
- **VaultMutationLock** around cross-pipeline vault/git mutation sections.
- **Runtime LLM JSON validation** via shared validators.
- **Graceful shutdown** through entrypoint signal handlers.
- **Dry-run / plan-only librarian modes** for previewing changes.
- **Doctor/status CLI commands** for operational inspection.
- **Shared source fetch policy** for API source timeout/retry behavior.

If a change removes or bypasses any of these, call it out explicitly and justify it.

## Extension surfaces

Future work should make these axes easier to extend without rewriting core workflows:

- source adapters
- scouts
- digest sections
- writer rules
- workflow compositions
- operational inspection commands

Prefer small modules with explicit contracts over large all-purpose workflow files.

## Where to read next

- `README.md` — top-level architecture and quick start.
- `pipelines/README.md` — operational details, phase shape, env vars, systemd.
- `docs/developer-guide.md` — extension surfaces and safety rules.
- `docs/architecture-improvement-notes.md` — roadmap, open questions, historical decisions.
- `CONTRIBUTING.md` — verification commands and contribution mechanics.

## Operational note

After Node upgrades, `better-sqlite3` may need rebuilding:

```bash
cd pipelines
npm rebuild better-sqlite3
```

Then verify with the commands in `CONTRIBUTING.md`.

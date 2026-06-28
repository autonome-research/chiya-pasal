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
Collection
  matcha/scripts/collect.sh
    → TypeScript API source adapters
    → RSS via matcha
    → filter_matcha.py
    → vault/raw/inbox/*.md

Intake
  raw inbox markdown
    → ArticleStore SQLite rows
    → pending queue

Librarian
  pending articles
    → router
    → topic/source/entity/citation scouts
    → reviewer
    → semantic article plans
    → serial deterministic apply
    → wiki/sources, wiki/topics, wiki/entities backlinks

Digest
  ArticleStore + vault context
    → classify
    → draft sections
    → append log
    → commit/squash/push
    → email
```

The vault itself is a separate git repo, usually `~/vault`. The pipeline database is usually `<vault>/.chiya-pipelines.db`.

## Canonical live format decisions

- The live raw inbox remains **Markdown-first** for now.
- JSONL/SQLite staging may be considered later, but only with a migration rationale.
- The TypeScript source adapter layer is live for API ingestion, but `filter_matcha.py` still performs final dedup/filter/raw-inbox rendering.

When working on collection, preserve the existing live artifacts unless deliberately changing the collection contract:

```text
matcha/scripts/api-articles.jsonl
matcha/scripts/api-digest.md
vault/raw/inbox/*-articles.md
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

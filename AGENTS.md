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

Demand ingestion (daily, all users — tier 3)
  shared citation_demand ledger
    → aggregate by DISTINCT citing article, merge refs naming the same paper
    → drop refs whose stable id already exists (satisfaction is COMPUTED)
    → arXiv/Crossref metadata
    → ONE <date>-demand-articles.md into the shared inbox
  (no vault, no git, no LLM — the vault proposes via citation counts, and the
   shared pipeline's normal quality gate still disposes)

Librarian (per enabled user in config/users.yaml)
  that user's pending articles
    → load topic vocabulary once (registry.json, else a live scan)
    → router
    → topic/source/entity/citation scouts   (explore THAT USER's vault,
                                             topic-scout sees the vocabulary)
    → reviewer                              (assigns against the vocabulary)
    → semantic article plans
    → serial deterministic apply            (fuzzy-correct unknown slugs, gate
                                             new topics, upsert entities)
    → wiki/sources, wiki/topics, wiki/entities backlinks
    → unresolved cites → External references + shared demand ledger

Lint (per enabled user)
  one scan of that user's vault
    → resolve external refs whose paper has since landed into real cites
      (the closing half of demand ingestion; runs first so every pass below
       sees the new edges in the same run, without a rescan)
    → regen registry (wiki/topics/_registry.md + registry.json)
    → recount cited_by from inbound cites:
    → re-rank topic member lists by importance
    → regen index.md (navigation surface, not a catalog)
    → export graph.json (nodes + edges for the visualization tool)
    → report broken links / orphans / stubs / near-duplicate topics
    → one commit

Digest (per enabled user)
  that user's undigested ArticleStore rows + vault context
    → classify
    → draft sections
    → append log
    → commit/squash/push
    → email that user, then stamp digested_at on exactly what was mailed
      (so PM is not a verbatim repeat of AM, and a failed send consumes nothing)
```

Each user's vault is its own git repo at `~/chiya-data/users/<handle>/vault`
with its pipeline DB inside it; the shared layer's cache + job log live at
`~/chiya-data/shared/articles.db`. Tenants are registered in
`pipelines/config/users.yaml` (managed via `npm run admin`).

## Vault artifact contracts

The vault's structure is deliberately legible to code, not just to humans. Four artifacts carry that contract; all four are **generated — never hand-edited, and never written by an LLM**.

| Artifact | Written by | Read by | Contract |
|---|---|---|---|
| `wiki/topics/_registry.md` | lint `regen-registry` | humans, foreground agents | Rendered by `renderRegistryMarkdown`. Presentation only — not round-trippable, so nothing parses it back. |
| `registry.json` (vault root) | lint `regen-registry` | librarian planner (`loadTopicRegistry`), future visualization tool | `{generatedAt, stats, clusters:[{name,topicCount}], topics:[{slug,title,oneLiner,clusters,memberCount,citedByTotal,updated}]}`. `parseRegistryJson` returns null on anything unexpected and the planner falls back to a live `scanTopicRegistry`, so a malformed or empty file degrades to a scan rather than blinding the agents. Keep this shape stable. |
| `graph.json` (vault root) | lint `export-graph` | future visualization tool, any agent wanting topology | `{generatedAt, stats, nodes[], edges[]}`, one record per line (committed to a git repo — pretty-printing turns one added source into a thousand-line diff). Node id IS the wikilink target (`wiki/sources/<name>`); clusters have no page and use `cluster:<name>`. Edge types: `member`, `cites`, `related`, `mentions`, container → contained. Edges only between existing nodes — a dangling reference is a broken link for the report, not an edge to nowhere. |
| `index.md` (vault root) | lint `regen-index` | humans, digest context | A navigation surface: clusters → their biggest topics, other page families, recent sources, stats. Explicitly **not** a catalog — the hand-maintained every-page index died at 21.8k sources. |

Two structural rules the whole system depends on:

- **Topics are a FLAT namespace** (`wiki/topics/<slug>.md`) with soft, overlapping `clusters:` frontmatter as the only grouping signal. Never a directory hierarchy, never a fixed tag taxonomy. Scanners ignore subdirectories under `wiki/topics/`; a page written into one is invisible to the registry, index, and graph.
- **`_`-prefixed filenames are generated artifacts** and are skipped by every scan, so a scan never ingests its own output.

The registry closes the loop that made 57% of sources `uncategorized`: lint enumerates the vocabulary → `registry.json` → the librarian injects a char-budgeted, cluster-grouped slug block into the topic-scout and reviewer prompts → the reviewer assigns against slugs that actually exist → apply's gate fuzzy-corrects the rest against fresh on-disk state. Registry = what the agents SEE; disk = what the gate BELIEVES. Don't collapse the two.

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
- **Content-compared vault writes in lint** — every lint write is diffed against current content first, so a run over an unchanged vault writes nothing and commits nothing. This is what makes a daily pass over 21.8k pages safe.
- **Deterministic lint** — no LLM anywhere in that pipeline, and Phase A lint reports structural problems rather than acting on them. Merges/deletions arrive later as agent proposals for code to dispose of, not as agent-driven writes.

If a change removes or bypasses any of these, call it out explicitly and justify it.

## Extension surfaces

Future work should make these axes easier to extend without rewriting core workflows:

- source adapters
- scouts
- digest sections
- writer rules
- workflow compositions
- operational inspection commands
- **lint passes** — a pass is a `Phase<LintCtx>` reading the single vault scan and writing through `planWrite`. Add one without touching the scan or the other passes; see `docs/developer-guide.md`.
- **graph projections** — `src/shared/graph-export.ts` is a pure node/edge projector. New node or edge kinds go there, not into the lint phase.
- **agent-facing vocabulary** — `vocabularyForPrompt` renders the registry into a char budget. Any new prompt that assigns against vault structure should take its vocabulary from there rather than re-scanning.

Prefer small modules with explicit contracts over large all-purpose workflow files.

## Where to read next

- `README.md` — top-level architecture and quick start.
- `pipelines/README.md` — operational details, phase shape, env vars, systemd.
- `docs/developer-guide.md` — extension surfaces and safety rules.
- `<vault>/CLAUDE.md` — the vault constitution: page schema, frontmatter contracts, clusters, generated artifacts, multi-writer rules. Anything that writes pages must match it.
- `docs/architecture-improvement-notes.md` — roadmap, open questions, historical decisions.
- `CONTRIBUTING.md` — verification commands and contribution mechanics.

## Operational note

After Node upgrades, `better-sqlite3` may need rebuilding:

```bash
cd pipelines
npm rebuild better-sqlite3
```

Then verify with the commands in `CONTRIBUTING.md`.

# Chiya Library — Architecture Review & Improvement Opportunities

Date: 2026-05-30

This document captures the current architecture review findings, known maintainability risks, and future opportunities for Chiya Library. It is intended as a working planning note before larger refactors.

## Current assessment

Chiya Library is already organized around a good core principle:

> Let agents explore, classify, and recommend; let deterministic code perform state changes, writes, commits, and recovery.

The TypeScript curation layer is in solid shape: strict TypeScript, passing tests, clear phase composition, dependency injection seams for agent calls, persisted job logs, bounded concurrency, and operational recovery for stale jobs/articles.

The main concerns are not foundational design problems. They are mostly about long-term maintainability, safer concurrent writes, stronger agent-output contracts, and making the collection/source layer easier to extend.

## Decisions from follow-up discussion

These are current working decisions, subject to revision as the design matures:

1. **Source synthesis can move from Python to TypeScript if it is better for the long run.** The likely benefit is one language/runtime for collection, intake, schemas, tests, and future extension surfaces.
2. **Keep the raw inbox Markdown-first for now.** Structured JSONL/SQLite staging remains open, but any change should be backed by a concrete reasoning discussion and migration plan.
3. **Do not change concurrent vault-write semantics without an interactive design discussion.** This is a correctness-sensitive area with real tradeoffs.
4. **The extension surface should eventually include all major axes:** adding sources, adding scouts, adding digest sections, changing write rules, and composing/decomposing workflows.
5. **The codebase should remain a solid secure core, but users/developers may modify it.** Runtime execution should enforce safety; source-level modification is acceptable.

## Suggested guardrails for a modular/extensible future

The goal is not to prevent developers from changing the project. The goal is to make unsafe runtime behavior difficult by default.

Potential guardrails:

- **Capability-scoped tools:** agents get read-only tools unless a phase explicitly grants write capability.
- **Deterministic side effects:** LLMs propose structured outputs; TypeScript code performs writes, git operations, email, and DB transitions.
- **Runtime schema validation:** every agent JSON contract is validated before downstream use.
- **Path sandboxing:** all vault file operations must go through `VaultFs` or an equivalent root-guarded API.
- **Dry-run mode:** side-effecting workflows should support previewing write intents, git commits, and email output.
- **Fixtures and contract tests:** every source adapter, scout, digest section, and writer rule should have small fixtures.
- **Explicit phase contracts:** each phase documents its required ctx fields and produced ctx fields.
- **Least privilege by workflow:** collector, curator, digest, and publisher should each receive only the env/secrets/tools they need.
- **Per-source and per-agent budgets:** timeouts, concurrency caps, token caps, and rate limits should be declared near the adapter/phase.
- **Human-readable audit trail:** every automatic write should be explainable through article/job logs.

## Issues and risks identified

### 1. Concurrent vault writes can lose updates

`perArticleTree` previously processed multiple articles concurrently and wrote topic/backlink pages inside each per-article runner. Several articles could touch the same topic page, cited source page, or entity page.

Old pattern:

```text
read page → append member/backlink → write page
```

If two article runners read the same old file and wrote independently, the last write could overwrite the first runner's update.

Implemented Phase 1 fix:

- replaced live librarian path with `planArticleTree` + `applyArticlePlans`
- planner performs router/scouts/reviewer/summary with bounded concurrency and no writes/status transitions
- apply phase serially revalidates reviewer output against fresh vault state
- apply phase performs deterministic writes and ArticleStore transitions one article at a time
- source page is written last as the completion marker
- per-article rollback restores only the failed article's touched files

Cross-pipeline follow-up implemented:

- `VaultMutationLock` now wraps librarian apply/metadata/commit and digest append/commit/push with an atomic lock directory under the vault root.

### 2. `librarian-phases.ts` is too large

`pipelines/src/phases/librarian-phases.ts` currently contains queue management, enrichment, reference extraction, per-article orchestration, rollback writing, deterministic writes, metadata merging, and git commit logic.

It is readable today, but it is becoming a mini-framework.

Potential split:

```text
pipelines/src/phases/librarian/
  queue-phases.ts
  enrichment-phase.ts
  refs-phase.ts
  per-article-runner.ts
  deterministic-writer.ts
  metadata-phase.ts
  commit-phase.ts
```

### 3. Digest phase module is also accumulating responsibility

Status: addressed as a first modularization pass.

`digest-phases.ts` now preserves the public export surface, while implementation lives under:

```text
pipelines/src/phases/digest/
  context.ts
  load-articles.ts
  classify.ts
  draft.ts
  assemble.ts
  publish.ts
```

This makes it easier for future agents/users to modify classification, drafting, or publishing behavior independently.

### 4. Agent output validation is uneven

The librarian scouts/reviewer are fairly defensive: they check truncation, malformed JSON, caps, and existence gates. The digest side is less strict.

Examples:

- classifier JSON is parsed but not strongly schema-validated
- bucket values are not fully runtime-validated
- draft sections do not check `finishReason === 'length'`
- path claims from scouts are mostly prompt-enforced, not tool-call verified

Potential fixes:

- introduce a shared schema validation helper, probably using `zod` or equivalent
- validate every LLM JSON contract at runtime
- treat unknown enum values as structured errors
- use executed tool calls as ground truth where possible
- add `verifyResult`-style checks for phases where correctness matters

### 5. Graceful cancellation is incomplete

The systemd units have timeouts and stale-lock recovery, which is good. However, the pipeline entrypoints do not appear to explicitly wire `SIGTERM` / `SIGINT` to `runner.cancel(...)`.

Potential fixes:

- add signal handlers in `intake.ts`, `librarian.ts`, and `digest.ts`
- abort in-flight work through the existing `AbortController`
- persist cancellation status before systemd hard-kills the process

### 6. Some duplication and legacy surfaces remain

Examples:

- `clientFor()` exists in multiple entrypoints
- `source-scout.ts` has an inline read-only vault registration even though `registerReadOnlyVaultTools` exists
- `vault.ts` still includes writable/tracked tool surfaces that may be legacy for the v3 librarian flow

Potential fixes:

- consolidate shared helpers
- remove or quarantine legacy v1/v2 tool surfaces
- add comments where old surfaces are intentionally retained for scripts/tests

### 7. Collection layer is more script-like than modular

The Python matcha collection scripts work and pass lint, but `api_ingest.py` is large and source-specific logic is centralized in one file.

Potential split:

```text
matcha/scripts/sources/
  semantic_scholar.py
  openalex.py
  crossref.py
  arxiv.py
  europe_pmc.py
  inspire.py
  zenodo.py
  doaj.py
matcha/scripts/common/
  candidate.py
  normalization.py
  dedup.py
  rate_limit.py
  output.py
```

### 8. Source addition is not yet a first-class extension path

Adding new APIs or RSS-derived source types currently requires editing collector logic directly. A future source system should make new source adapters easy to add and test.

Potential adapter shape:

```python
class SourceAdapter:
    name: str
    def fetch(self, config, interests) -> list[ArticleCandidate]: ...
    def normalize(self, raw) -> ArticleCandidate: ...
```

Or equivalent functional registry:

```python
SOURCES = [
    OpenAlexSource(),
    ArxivSource(),
    CrossrefSource(),
]
```

### 9. Raw inbox format could become more machine-native

Collection writes Markdown into `vault/raw/inbox`, then intake parses that Markdown back into structured rows. This is human-inspectable, but less robust than a structured interchange format.

Potential future model:

- collector emits JSONL/NDJSON as canonical machine input
- optional Markdown digest remains as a human artifact
- intake reads structured records directly

### 10. Configuration is still somewhat local-machine specific

Defaults assume the current local vault, tiny-emerson tunnel, Ollama-style OpenAI-compatible endpoints, and user-level systemd.

This is fine for the current deployment, but future reuse by other users/agents would benefit from clearer environment profiles.

Potential fixes:

- named config profiles: local, remote, dry-run, test
- one `chiya doctor` command to validate vault, DB, inference, git, email, and collection sources
- generated systemd/cron templates from config

### 11. Observability is good but could become more actionable

Current logs are useful, and job events are persisted. Future improvements could make operations easier.

Potential additions:

- source health summary per collection run
- article lifecycle dashboard or CLI
- per-source yield/drop stats
- per-agent latency/token/tool-call stats
- failure summaries grouped by phase/reason

### 12. Database migrations are mostly script-driven

There are migration scripts, but the project may eventually benefit from a small formal migration mechanism for the ArticleStore schema and job metadata.

Potential fixes:

- `schema_version` table
- ordered migration files
- startup migration check
- dry-run migration command

## Future vision themes

### A. More robust and extensible source synthesis

The collection layer should become a source synthesis engine rather than a set of scripts.

Future goals:

- easy to add a new source without editing core collector logic
- per-source fetch/parse/normalize tests
- standard `ArticleCandidate` schema
- structured source quality reports
- source-level retries, rate limits, and backoff
- duplicate handling based on canonical IDs: DOI, arXiv ID, URL hash, title similarity
- optional source confidence/quality scoring
- machine-native JSONL output plus human-readable Markdown digest

Possible shape:

```text
collect config
→ source adapters fetch raw candidates
→ normalize to ArticleCandidate
→ enrich/canonicalize identifiers
→ dedup/merge candidates
→ filter low-signal candidates
→ emit raw inbox JSONL + human digest
```

### B. Workflow refactor into smaller modules

The TypeScript pipeline should be decomposed into smaller units that are easier for humans and agents to modify independently.

Future goals:

- one file per major phase family
- explicit input/output contracts per phase
- clear dependency injection for stores, vault, git, inference, email
- reusable per-article runner separate from phase wrapper
- deterministic writer module separate from agent recommendation modules
- write-intent model to make batch-level serial writes possible

Potential structure:

```text
pipelines/src/workflows/
  intake/
  librarian/
    queue.ts
    enrichment.ts
    refs.ts
    route.ts
    scouts/
    review.ts
    write-intents.ts
    apply-writes.ts
    metadata.ts
  digest/
    context.ts
    classify.ts
    draft.ts
    publish.ts
```

### C. Easier decomposition for other users or agents

The project could become not just one personal automation, but a reusable pattern for agentic research libraries.

Future goals:

- documented phase contracts
- reusable templates for new pipelines
- dry-run modes for all side-effecting phases
- fixtures for vault, article store, and agent outputs
- task-sized modules that future coding agents can safely modify
- a contributor guide explaining how to add a source, a scout, a digest section, or a vault write rule

### D. Preserve the most important design principle

Even as the project becomes more modular, it should preserve the current safety pattern:

```text
LLMs propose; deterministic code disposes.
```

Agents should continue to:

- explore with read-only tools
- produce bounded structured recommendations
- be validated against runtime schemas and vault state

Code should continue to:

- own writes
- own rollback/retry/recovery
- own git/email side effects
- own idempotency and concurrency controls

## Candidate roadmap

### Phase 0 — planning and documentation

- keep this document updated
- document current phase contracts
- identify which legacy surfaces are still needed

### Phase 1 — safety hardening

- fix concurrent vault write race (implemented for the librarian hot path via semantic plans + serial apply)
- add cross-pipeline vault/git mutation lock (implemented with `VaultMutationLock`)
- add graceful signal cancellation (started: entrypoints now install SIGTERM/SIGINT handlers)
- add stronger LLM output validation (started: digest classifier uses shared lightweight validator; other agents still ad hoc)
- check digest truncation and invalid buckets (started: section drafts throw on truncation; invalid classifier buckets become skip)

### Phase 2 — pipeline modularization

- split librarian phases (started: planner/apply split landed; queue/enrichment/refs still in `librarian-phases.ts`)
- split digest phases (implemented under `src/phases/digest/`)
- extract common runner/env/client helpers
- isolate deterministic writer logic (started: `librarian-apply.ts`)

### Phase 3 — matcha/source synthesis refactor

- introduce `ArticleCandidate` schema (scaffolded in TypeScript under `pipelines/src/collection`)
- create source adapter registry (scaffolded in TypeScript under `pipelines/src/collection`)
- add first concrete TypeScript source adapter (`arxivSource`, fixture-tested; not yet live)
- split/port `api_ingest.py` by source
- emit Markdown-first raw inbox for now; revisit JSONL only with a migration rationale
- keep Markdown as the canonical live collection artifact until a later decision

### Phase 4 — reuse and agent-friendliness

- add contributor/developer docs (started: `docs/developer-guide.md`)
- add dry-run workflows
- add source and phase templates
- add operational `doctor`/inspection commands

## Open questions for discussion

1. Should collection remain in Python, or should source synthesis move into TypeScript for shared schemas with `ArticleStore`?
2. Should raw inbox canonical format become JSONL, SQLite staging rows, or remain Markdown-first?
3. Should vault writes be serialized globally, per path, or by write-intent batch apply?
4. Should Chiya stay optimized for one local deployment, or become a reusable package/template?
5. What is the desired extension surface for other users: adding sources, adding scouts, adding digest sections, or all of the above?
6. How much should future agents be allowed to modify directly, and what guardrails should exist around those changes?

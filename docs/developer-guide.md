# Chiya Developer Guide

This guide describes the extension surfaces that should remain safe and modular as Chiya grows.

## Core principle

LLMs propose; deterministic code disposes.

Agents should explore with scoped tools and return bounded structured outputs. TypeScript code should own filesystem writes, database transitions, git operations, email, idempotency, and recovery.

## Adding a source adapter

The TypeScript source-synthesis layer lives in `pipelines/src/collection/`. Concrete adapters live under `pipelines/src/collection/sources/` and currently cover arXiv, OpenAlex, Crossref, Semantic Scholar, plus legacy academic APIs in `legacy-academic.ts`.

A source adapter implements:

```ts
import type { SourceAdapter } from '../source-adapter.js';

export const mySource: SourceAdapter<MyConfig> = {
  name: 'my-source',
  async fetch(config, ctx) {
    return {
      candidates: [/* ArticleCandidate[] */],
      report: { source: 'my-source', fetched: 1, emitted: 1, dropped: 0, warnings: [] },
    };
  },
};
```

Rules:

- emit `ArticleCandidate` objects, not vault pages
- normalize title/url/source fields
- include canonical identifiers when available (`doi`, `arxivId`)
- return a source health report with fetched/emitted/dropped counts
- test parsing with local fixtures, not live network calls
- keep the live Markdown-first collector behavior unchanged until a deliberate migration decision

## Adding or changing a digest section

Digest implementation is split under `pipelines/src/phases/digest/`:

- `context.ts` — reads vault context
- `load-articles.ts` — loads candidates from `ArticleStore`
- `classify.ts` — assigns digest buckets
- `draft.ts` — drafts section markdown
- `assemble.ts` — builds the final digest body
- `publish.ts` — log/commit/push/email side effects

Rules:

- validate any LLM JSON with `src/shared/llm-schema.ts`
- check `finishReason === 'length'`
- keep side effects in `publish.ts`
- run publishing under the vault mutation lock

## Adding or changing a scout

Scouts live under `pipelines/src/phases/scouts/` and are used by `librarian-planner.ts`.

Rules:

- scouts should be read-only
- scouts surface candidates; they do not make final write decisions
- cap surfaced pages
- return structured errors instead of throwing for ordinary model failures
- provide dependency injection seams for tests
- test truncation, parse failure, empty results, and happy path

## Changing vault writes

Vault writes happen in `librarian-apply.ts` and digest `publish.ts`.

Rules:

- all paths go through `VaultFs`
- librarian planning must not write files or update article status
- apply plans serially and revalidate against fresh vault state
- write source pages last as completion markers
- run cross-pipeline mutation sections under `VaultMutationLock`

## Safety checklist

Before merging changes:

```bash
cd pipelines
npm run typecheck
npm test
```

For native binding issues after Node upgrades:

```bash
npm rebuild better-sqlite3 --silent
```


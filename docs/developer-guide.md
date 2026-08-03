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
    // Prefer shared helpers from ../fetch.js so source calls get consistent
    // timeout/retry behavior and health warnings.
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
- return a source health report with fetched/emitted/dropped counts plus relevant warnings
- use shared source fetch helpers for timeout/retry behavior unless the source requires custom protocol handling
- test parsing with local fixtures, not live network calls
- keep the live Markdown-first collector behavior unchanged until a deliberate migration decision
- preserve cross-day dedup safety: the raw collector checks archived `*-articles.md` files, while ArticleStore remains the long-term dedup source of truth

## Changing the shared pipeline (absorb / enrich / summarize / route)

The multi-tenant shared layer lives in `pipelines/src/phases/shared/` with its store in `pipelines/src/shared/shared-article-store.ts` and entry point `pipelines/src/shared-pipeline.ts`. It runs once per article for all users.

Rules:

- respect the article FSM: `pending → enriched | enrich-failed → summarized → (embedded →) routed | rejected-quality | failed`. Mark a status only after the work it records is durably complete — crash-resumability depends on it.
- enrichment failures must be classified: retryable (timeouts, 429/5xx) stay `pending`; permanent failures go `enrich-failed` and fall back to the abstract. Never let one bad URL wedge the queue.
- the quality gate is conservative by design: it only drops `kind` announcement/other or `rigor ≤ 1`, and fails open when the `## Assessment` block can't be parsed. Rejected rows keep their assessment columns (`quality_*`) so the gate floor can be tuned from data — don't discard them.
- routing must support both modes behind `CHIYA_ROUTING_MODE` (`embedding` and `broadcast`); never make the embedding endpoint a hard dependency of the pipeline.
- routed articles are COPIED into each user's ArticleStore (summary → `snippet`, refs columns, shared provenance). Per-user stores stay independently rebuildable; don't introduce cross-store references.
- in embedding mode, log the full score matrix to `routing_log` — it is the tuning data for the threshold.
- tenants come from `config/users.yaml` via `pipelines/src/shared/users.ts`; mutate the registry only through `npm run admin -- users ...` (comment-preserving YAML transforms in `users-admin.ts`).

## Adding or changing a digest section

Digest implementation is split under `pipelines/src/phases/digest/`:

- `context.ts` — reads vault context
- `load-articles.ts` — loads candidates from `ArticleStore`
- `classify.ts` — assigns digest buckets
- `draft.ts` — drafts section markdown
- `assemble.ts` — builds the Markdown digest body and attaches HTML email output
- `render-html.ts` — deterministic, email-safe HTML renderer with embedded source links
- `publish.ts` — log/commit/push/email side effects

Rules:

- validate any LLM JSON with `src/shared/llm-schema.ts`
- check `finishReason === 'length'`
- keep side effects in `publish.ts`
- run vault/git publishing under the vault mutation lock
- do not ask LLMs to produce HTML; render email HTML deterministically in TypeScript
- escape all article/model text before inserting into HTML, and only turn validated source URLs into links
- email delivery failures should throw so digest jobs are visibly failed

## Adding or changing a scout

Scouts live under `pipelines/src/phases/scouts/` and are used by `librarian-planner.ts`.

Rules:

- scouts should be read-only
- scouts surface candidates; they do not make final write decisions
- cap surfaced pages
- return structured errors instead of throwing for ordinary model failures
- provide dependency injection seams for tests
- test truncation, parse failure, empty results, and happy path

## Agent token budgets

Every output-token cap in the pipelines lives in `pipelines/src/shared/agent-budgets.ts`. Nothing else may name one.

This is not tidiness. Four incidents in one week were the same bug: a numeric constant tuned for one dependency state, the dependency moved, the constant went silently wrong. Nothing throws — `finishReason` turns `'length'` and data quality degrades for weeks while every job reports COMPLETED.

- digest classify/draft at 800/2500, sized for the non-reasoning gemma4:e4b. After the qwen3 switch the hidden reasoning pass ate the whole cap: classify force-skipped **every** article and draft threw.
- the reviewer's hardcoded 2500 — same root cause, missed while fixing the first one, then made worse when a 6k-char topic vocabulary entered its prompt. 31 articles deferred on `truncated` in one evening, and the vocabulary added to *prevent* uncategorized filings was causing them.

A cap tuned for a non-reasoning model is not "a bit tight" for a reasoning model. The reasoning pass runs *before* the first output token, so an undersized cap produces zero output, not short output.

### Where they live

`agent-budgets.ts` exports one named budget per agent role plus an `AGENT_BUDGETS` registry:

| field | meaning |
| --- | --- |
| `value` | effective cap in this process (env override, then floor) |
| `envVar` | `CHIYA_<ROLE>_MAX_TOKENS` |
| `floor` | `Math.max` clamp — a typo'd env var cannot reintroduce the truncation bug |
| `fallback` | compiled-in default |
| `agentName` | the `name` passed to `runAgentWithTools`, i.e. what appears in the JobStore event log |
| `why` / `invalidatedBy` | why the number holds, and what change makes it wrong |

`invalidatedBy` is the field that matters. **On any model swap, read every `invalidatedBy` in the file.** That is the review step whose absence caused all four incidents.

`npm run budgets` prints the effective values; `npm run doctor -- --no-network` reports them as the `budgets` check alongside `truncation`, which measures whether any agent is actually hitting its ceiling.

### Adding an agent

1. Add a role to `AgentRole`, a `resolveBudget(...)` export, and an `AGENT_BUDGETS` entry with a real `why` and `invalidatedBy` (the test rejects placeholder-length strings).
2. Import the constant at the call site: `maxTokens: MY_AGENT_MAX_TOKENS`.
3. Set `agentName` to the exact `name` you pass `runAgentWithTools`.

### Why bare literals fail the test

`__tests__/agent-budgets.test.ts` globs `src/**/*.ts` + `scripts/**/*.ts` (never a hand-maintained list, so a new agent file is covered the day it lands) and fails on:

1. a numeric literal after `maxTokens:` anywhere outside the budgets module — reported as `file:line` with instructions;
2. a file that calls `runAgentWithTools(` without importing from `agent-budgets.js` — an agent silently running on the adapter's default cap is the same failure with no constant left to grep for;
3. an `agentName` in the registry that matches no agent in the sources, so a rename cannot leave a stale entry behind.

The check takes ~15ms (`npm run test:guards`). If it fires, do not add an exemption — move the number.

Note the regex is camelCase `maxTokens` only. `max_tokens` in `src/doctor.ts` is a raw OpenAI probe body, not a thread-phase agent budget. If a phase ever calls the OpenAI client directly, widen the pattern to `/\bmax_?[Tt]okens/` and exempt doctor explicitly.

## Topic registry and vocabulary

`pipelines/src/shared/topic-registry.ts` owns the vault's topic vocabulary: one scan of `wiki/topics/*.md` produces a `TopicRegistry` value, which is rendered three ways — a human page, a machine document, and a char-budgeted block for agent prompts.

The contract, and who is on each side of it:

| | Writer | Reader |
|---|---|---|
| `wiki/topics/_registry.md` | lint `regen-registry` via `renderRegistryMarkdown` | humans only — presentation, not round-trippable, nothing parses it back |
| `registry.json` (vault root) | lint `regen-registry` via `renderRegistryJson` | `loadTopicRegistry` in `librarian-planner.ts`; future visualization tool |
| prompt vocabulary block | `vocabularyForPrompt(reg, {maxChars})` | topic-scout (2000 chars) and reviewer (6000 chars) system prompts |

Rules:

- **Topics are flat.** `scanTopicRegistry` reads only `wiki/topics/*.md`, never subdirectories — recursing would reintroduce the slug ambiguity the flattening migration removed. Files starting with `_` are generated artifacts and are skipped so a scan cannot ingest its own output.
- **Clusters are soft metadata**, multi-valued and overlapping, validated for shape only — never checked against an approved list. The reviewer is the only source of cluster growth for new topics; existing topics get clusters by hand-editing their frontmatter.
- **Keep `renderRegistryJson`'s shape stable.** `parseRegistryJson` returns `null` on anything unexpected and a parsed-but-empty registry also falls through to a live `scanTopicRegistry`, so a bad emitter degrades to a slower scan instead of blinding the agents. Adding fields is safe; renaming or reshaping `clusters[]` / `topics[]` is not.
- **`generatedAt` is caller-supplied**, never read from the clock inside the module, so one run stamps every artifact identically and tests are stable.
- **Vocabulary budget allocation is breadth-first by design.** Every group gets a header and one slug before any group gets a second; leftover budget is distributed round-robin in importance order. A greedy fill would hand the whole budget to the largest cluster and the reviewer would never learn the others exist — which is the blindness the registry exists to fix. The unclustered pile is ranked as a group like any other.
- **Append the vocabulary to the END of a static system prompt.** The cacheable prefix must stay byte-identical across runs; tests pin this.
- **`nearestSlugs` proposes; the caller disposes.** Its `MIN_SIMILARITY` floor is recall-first. Every consumer adds its own acceptance gate: the reviewer's fuzzy correction requires `isNearDuplicate` or a length-scaled edit budget; the lint duplicate report compares only the tokens two slugs do *not* share. Don't lower the floor to make a consumer happier — tighten the consumer's gate.
- If you need a registry-derived value in a pipeline that already walks the vault, build the `TopicRegistry` from `parseTopicPage` + `readFrontmatterList` rather than calling `scanTopicRegistry` (which re-reads every member source to derive `citedByTotal`). Render through the same `render*` functions so output stays identical.

## Lint passes

The lint pipeline (`pipelines/src/lint.ts`, phases in `pipelines/src/phases/lint-phases.ts`) is the vault's "organize" organ: deterministic TypeScript only, no LLM. `scan-vault` runs first and is the only reader of page bodies; every later pass works off `LintCtx`.

To add a pass:

```ts
export const myPass = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'my-pass',
  async *run(ctx) {
    const sources = requireCtx(ctx, 'sources', 'my-pass');   // fail loudly on bad phase order
    const outcome = await planWrite(ctx, vault, 'some/path.md', rendered);
    ctx.stats.myPassChanged = outcome === 'unchanged' ? 0 : 1;
    yield { type: 'phase', phase: 'my-pass', detail: `some/path.md: ${outcome}`, counts: { … } };
  },
});
```

Then register it in the `mutating` array in `lint.ts` — order matters, and `commit-lint` must stay last.

Rules:

- **Every write goes through `planWrite`.** It content-compares first and returns `unchanged` / `written` / `would-write`, and it is the only thing that honours `ctx.dryRun`. A pass that calls `vault.write` directly breaks dry-run *and* makes the daily timer churn git history on an unchanged vault.
- **Don't re-walk the vault.** If your pass needs a field the scan doesn't collect, add it to `LintSourceRecord` / `LintTopicPage` and populate it in `scan-vault`. A second walk over 21.9k files costs more than the extra bytes.
- **Rewrite lines, don't regenerate pages.** `recount-citations` replaces one frontmatter line via `bumpFrontmatterField`; `rank-topic-members` writes sorted lines back into the exact indices they occupied. A pass that reformats a page it did not author will silently destroy hand-written content — refuse and count instead (`rerankMemberSection` returns `unparseable`).
- **Reporting is not acting.** Phase A lint deletes, merges, and archives nothing. Judgment-driven cleanup belongs to a later phase and must still arrive as LLM proposals disposed of by deterministic code.
- **Cap what rides the event stream.** Full lists go out as `{type:'data'}` events truncated at `MAX_REPORT_ITEMS` with `truncatedAt` in the payload; counts stay exact. The job store persists every event and the live vault produces five-figure lists.
- **Call `ctx.heartbeat?.()` inside long loops** (every `HEARTBEAT_EVERY` files) or a slow run gets reclaimed as abandoned mid-flight.
- **Anything touching the working tree runs under `VaultMutationLock`** — that is why only `scan-vault` sits outside it in `lint.ts`. Dry-run skips the lock because it writes nothing.
- **Filter pathspecs before staging.** `git add -- CLAUDE.md` fails outright on a vault without that file, which would abort the run; `commit-lint` checks existence first.
- **Test with tmp-dir fixtures**, not the live vault, and pin both the changed and unchanged outcomes — "an unchanged vault produces zero writes" is a behavior, not an implementation detail.

## Changing vault writes

Vault writes happen in `librarian-apply.ts` and digest `publish.ts`.

Rules:

- all paths go through `VaultFs`
- librarian planning must not write files or update article status
- apply plans serially and revalidate against fresh vault state
- write source pages last as completion markers (entity upserts sit between topic touches and the source write, and go through the same per-article writer log so rollback removes created entity pages)
- run cross-pipeline mutation sections under `VaultMutationLock`
- never write `index.md`, `registry.json`, `graph.json`, or `wiki/topics/_registry.md` from anywhere but the lint pass — they are regenerated wholesale, so any other writer's changes are lost on the next run
- keep frontmatter to single-level scalars and one-line inline arrays; every mutator in the repo is line-based and nested YAML will not round-trip

## Safety checklist

Before merging changes:

```bash
cd pipelines
npm run typecheck
npm test
npm run doctor:offline   # truncation rates + effective agent caps; no network, read-only
```

For native binding issues after Node upgrades:

```bash
npm rebuild better-sqlite3 --silent
```

If ArticleStore is lost/reset but raw inbox archives remain, recover with:

```bash
npm run backfill-archive-articles -- --status=done     # dedup memory only
npm run backfill-archive-articles -- --status=pending  # re-queue archived resources
```

Backfill uses archive filenames for `collected_at`, so restored historical resources do not appear as newly collected today.


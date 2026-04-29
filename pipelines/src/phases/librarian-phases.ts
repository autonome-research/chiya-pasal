/**
 * Librarian pipeline phases.
 *
 * Composed in src/librarian.ts. Order:
 *   reapStale → loadBatch → processBatch → mergeMetadata → commitLocal
 *
 * Per-article work happens inside processBatch's bounded fanout. Each
 * worker does triage (cheap LLM, no_think) → maybe-upsert (heavy LLM with
 * vault tools) → DB status transition. No /tmp deltas; per-worker
 * ArticleResult flows back through ctx for mergeMetadata.
 */

import {
  parseJSON,
  requireCtx,
  runAgentWithTools,
  ToolRegistry,
  type Phase,
} from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';

import { ArticleStore, type ArticleRow } from '../shared/article-store.js';
import type { ArticleResult, LibrarianCtx } from '../shared/librarian-types.js';
import { GitOps } from '../tools/git.js';
import { VaultFs, registerVaultTools } from '../tools/vault.js';
import { registerWebTools } from '../tools/web.js';

const STALE_PROCESSING_MINUTES = 60;

// ---------------------------------------------------------------------------
// reapStale — recover any rows stuck in 'processing' from a crashed run
// ---------------------------------------------------------------------------

export const reapStale = (store: ArticleStore): Phase<LibrarianCtx> => ({
  name: 'reap-stale',
  async *run(ctx) {
    const reaped = store.reapStaleProcessing(STALE_PROCESSING_MINUTES);
    ctx.reaped = reaped;
    yield {
      type: 'phase',
      phase: 'reap-stale',
      detail: reaped > 0 ? `recovered ${reaped} stuck row(s)` : 'no stale rows',
      counts: { reaped },
    };
  },
});

// ---------------------------------------------------------------------------
// loadBatch — pull next N pending rows; mark all as 'processing' atomically
// ---------------------------------------------------------------------------

export const loadBatch = (store: ArticleStore): Phase<LibrarianCtx> => ({
  name: 'load-batch',
  async *run(ctx) {
    const batch = store.listPending(ctx.batchSize);
    ctx.batch = batch;

    for (const row of batch) {
      store.markProcessing(row.id);
    }

    if (batch.length === 0) {
      ctx.stop = { reason: 'queue-empty' };
    }

    yield {
      type: 'phase',
      phase: 'load-batch',
      detail: `${batch.length} article(s) pulled (status='processing')`,
      counts: { batch: batch.length, totalPending: store.countByStatus().pending + batch.length },
    };
  },
});

// ---------------------------------------------------------------------------
// processBatch — per-article: triage → maybe-upsert. Bounded fan-out.
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM = `You are a research wiki librarian's first-pass triager. You decide whether an article is worth turning into / updating a wiki page.

Reply ONLY with JSON of the form:
{"keep": true | false, "reason": "<one short clause>"}

Skip ("keep": false) when:
- the title indicates a correction, erratum, retraction, addendum, editorial, or table-of-contents
- the snippet is empty AND the URL is empty (nothing to research)
- the article is in an off-domain field (humanities, education, law unless legal-tech) given the user's interests
- the snippet is OCR garbage (repeated words like "the the the")
- it's a near-duplicate of a topic the wiki already covers extensively (use the index excerpt below)

Keep ("keep": true) when there's any plausible signal — substantive abstract, recognizable research, named entities, novel field intersection. Be moderately permissive; the heavy upsert phase will do a deeper check.`;

const UPSERT_SYSTEM_TEMPLATE = (
  taste: string,
  index: string,
) => `You are a research wiki librarian. You read one article at a time, decide whether to create or update wiki pages, and use the provided tools to actually do it.

You have these tools:
- vault_read(path)            — read a vault file
- vault_write(path, content)  — write/overwrite a vault file (creates dirs)
- vault_list(pattern)         — glob within the vault
- vault_exists(path)          — check existence
- web_fetch(url)              — fetch a URL when the snippet is too thin

Process:
1. If the snippet is shorter than ~200 chars and the URL is non-empty, fetch the URL for more context. (Skip fetch for bare DOI URLs that aren't HTTP.)
2. Decide: is there an entity or topic where this article would meaningfully strengthen the wiki?
   - If no: respond with {"action": "skipped", "reason": "<short>", "paths": []}
   - If yes: create or update one or two pages.
3. When writing pages, follow these conventions:
   - YAML frontmatter: type, status, updated (today's date), sources (count), tags, confidence
   - Lowercase-hyphen filenames, no spaces
   - At least 2 [[wikilinks]] per page
   - File under the right dir: entities/, topics/<field>/, projects/, research/<project>/
   - Topic pages should synthesize across sources, not just summarize this one

Tag taxonomy is documented in ~/vault/CLAUDE.md if you need to look it up.

After writing, respond with:
{
  "action": "created" | "updated" | "skipped",
  "reason": "<short>",
  "paths": ["wiki/topics/...", ...],
  "logEntry": "<one line for log.md, no leading ##>",
  "indexDeltas": ["<index line for new/updated entry>", ...]
}

Be efficient. One vault_read on the index when needed, then act.

================================================================================
USER CONTEXT (cached prefix — same across articles in this run)
================================================================================

## TASTE
${taste.slice(0, 1500) || '(empty)'}

## Wiki index excerpt (first 4k chars)
${index.slice(0, 4000)}`;

export interface ProcessBatchClients {
  /** Fast no-tool model for the triage gate. */
  triageClient: OpenAI;
  triageModel: string;
  /** Tool-capable model for wiki upsert (vault read/write + web fetch). */
  upsertClient: OpenAI;
  upsertModel: string;
}

export const processBatch =
  (
    clients: ProcessBatchClients,
    store: ArticleStore,
    vault: VaultFs,
    concurrency: number = 4,
  ): Phase<LibrarianCtx> =>
  ({
    name: 'process-batch',
    async *run(ctx) {
      const batch = requireCtx(ctx, 'batch', 'process-batch');
      if (batch.length === 0) {
        ctx.results = [];
        return;
      }

      // Build the upsert system prompt once (vault context shared across
      // all per-article calls so vLLM prefix-cache hits).
      const [taste, index] = await Promise.all([
        vault.read('wiki/TASTE.md'),
        vault.read('index.md'),
      ]);
      const upsertSystem = UPSERT_SYSTEM_TEMPLATE(taste, index);

      // Each worker gets its own ToolRegistry so tool calls aren't cross-contaminated.
      // (Stateless tools so the per-worker registry could be shared, but isolating is cheaper than reasoning about it.)
      const buildRegistry = (): ToolRegistry => {
        const reg = new ToolRegistry();
        registerVaultTools(reg, vault);
        registerWebTools(reg);
        return reg;
      };

      yield {
        type: 'phase',
        phase: 'process-batch',
        detail: `${batch.length} articles, concurrency=${concurrency}`,
      };

      const results: ArticleResult[] = await boundedFanout({
        items: batch,
        concurrency,
        runner: async (article): Promise<ArticleResult> => {
          // Past the deadline? Mark this article back to pending so a
          // future run picks it up, return a soft "skipped:deadline".
          if (Date.now() > ctx.deadlineAt.getTime()) {
            const db = (store as unknown as {
              db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } };
            }).db;
            db.prepare(
              `UPDATE article SET status='pending', processed_at=NULL WHERE id=?`,
            ).run(article.id);
            return { articleId: article.id, outcome: 'skipped', reason: 'deadline-rolled-over', pagePaths: [], indexDeltas: [] };
          }

          // Triage call
          const triage = await callTriage(clients.triageClient, clients.triageModel, article);
          if (!triage.keep) {
            store.markSkipped(article.id, triage.reason);
            return {
              articleId: article.id,
              outcome: 'skipped',
              reason: triage.reason,
              pagePaths: [],
              logEntry: `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ingest | skip — ${article.title.slice(0, 80)} (${triage.reason})`,
              indexDeltas: [],
            };
          }

          // Upsert call
          try {
            const upsert = await callUpsert(
              clients.upsertClient,
              clients.upsertModel,
              upsertSystem,
              article,
              buildRegistry(),
            );
            if (upsert.action === 'skipped') {
              store.markSkipped(article.id, upsert.reason);
              return {
                articleId: article.id,
                outcome: 'skipped',
                reason: upsert.reason,
                pagePaths: [],
                logEntry: upsert.logEntry,
                indexDeltas: upsert.indexDeltas,
              };
            }
            store.markDone(article.id, upsert.paths);
            return {
              articleId: article.id,
              outcome: 'done',
              pagePaths: upsert.paths,
              logEntry: upsert.logEntry,
              indexDeltas: upsert.indexDeltas,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            store.markFailed(article.id, msg.slice(0, 200));
            return {
              articleId: article.id,
              outcome: 'failed',
              reason: msg.slice(0, 200),
              pagePaths: [],
              indexDeltas: [],
            };
          }
        },
        onItemDone: () => {
          // Could yield progress here, but boundedFanout's onItemDone is
          // sync and we're inside an async generator — buffer for the
          // post-loop summary instead.
        },
      });

      ctx.results = results;

      const tally = results.reduce(
        (acc, r) => {
          acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
          return acc;
        },
        { done: 0, skipped: 0, failed: 0 } as Record<string, number>,
      );
      yield {
        type: 'phase',
        phase: 'process-batch',
        detail: `done=${tally.done} skipped=${tally.skipped} failed=${tally.failed}`,
        counts: tally,
      };
    },
  });

interface TriageDecision {
  keep: boolean;
  reason: string;
}

async function callTriage(
  client: OpenAI,
  model: string,
  article: ArticleRow,
): Promise<TriageDecision> {
  const r = await runAgentWithTools(
    {
      name: 'triage',
      systemPrompt: TRIAGE_SYSTEM,
      model,
      tools: [],
      maxToolRounds: 1,
      maxTokens: 200,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
    [
      {
        role: 'user',
        content: `Title: ${article.title}\nField: ${article.field ?? '(none)'}\nURL: ${article.url ?? '(empty)'}\n${article.snippet ? `Snippet: ${article.snippet.slice(0, 400)}` : 'Snippet: (none)'}`,
      },
    ],
    { client, toolExecutor: { execute: async () => ({ toolCallId: '', content: '' }) } },
  );
  return parseJSON<TriageDecision>(r.text, { keep: false, reason: 'parse-failed' });
}

interface UpsertDecision {
  action: 'created' | 'updated' | 'skipped';
  reason: string;
  paths: string[];
  logEntry?: string;
  indexDeltas: string[];
}

async function callUpsert(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  article: ArticleRow,
  registry: ToolRegistry,
): Promise<UpsertDecision> {
  const r = await runAgentWithTools(
    {
      name: 'upsert',
      systemPrompt,
      model,
      tools: registry.definitions(),
      maxToolRounds: 8,
      maxTokens: 4000,
      // Reasoning ON for upsert — the writer benefits from thinking through
      // page structure and cross-references before writing.
    },
    [
      {
        role: 'user',
        content:
          `Article to consider:\n` +
          `Title: ${article.title}\n` +
          `URL: ${article.url ?? '(empty)'}\n` +
          `Source: ${article.source ?? '(unknown)'}\n` +
          `Field: ${article.field ?? '(unknown)'}\n` +
          `Snippet: ${article.snippet ?? '(none)'}\n\n` +
          `Decide. If you write pages, return the structured JSON described in your instructions.`,
      },
    ],
    { client, toolExecutor: registry, cache: undefined },
  );
  const fallback: UpsertDecision = { action: 'skipped', reason: 'parse-failed', paths: [], indexDeltas: [] };
  const parsed = parseJSON<Partial<UpsertDecision>>(r.text, fallback);
  return {
    action: parsed.action ?? 'skipped',
    reason: parsed.reason ?? 'no reason given',
    paths: parsed.paths ?? [],
    logEntry: parsed.logEntry,
    indexDeltas: parsed.indexDeltas ?? [],
  };
}

// ---------------------------------------------------------------------------
// mergeMetadata — append log entries, append index deltas
// ---------------------------------------------------------------------------

export const mergeMetadata = (vault: VaultFs): Phase<LibrarianCtx> => ({
  name: 'merge-metadata',
  async *run(ctx) {
    const results = requireCtx(ctx, 'results', 'merge-metadata');
    const logEntries = results
      .map((r) => r.logEntry)
      .filter((e): e is string => Boolean(e));
    const indexDeltas = results.flatMap((r) => r.indexDeltas);

    if (logEntries.length > 0) {
      const block = logEntries.map((e) => `## ${e.replace(/^## ?/, '')}`).join('\n\n');
      await vault.append('log.md', '\n' + block + '\n');
    }

    if (indexDeltas.length > 0) {
      // Naive: append to the bottom of index.md. The midnight vault-daily-lint
      // job (still on Hermes) re-sorts and dedupes — we don't try to be smart
      // about placement here.
      const block = indexDeltas.map((d) => `${d}`).join('\n');
      await vault.append('index.md', '\n' + block + '\n');
    }

    yield {
      type: 'phase',
      phase: 'merge-metadata',
      detail: `${logEntries.length} log entries, ${indexDeltas.length} index deltas`,
      counts: { log: logEntries.length, index: indexDeltas.length },
    };
  },
});

// ---------------------------------------------------------------------------
// commitLocal — single local commit per run, no push
// ---------------------------------------------------------------------------

export const commitLocal = (git: GitOps): Phase<LibrarianCtx> => ({
  name: 'commit-local',
  async *run(ctx) {
    const results = requireCtx(ctx, 'results', 'commit-local');
    const tally = results.reduce(
      (acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      },
      { done: 0, skipped: 0, failed: 0 } as Record<string, number>,
    );
    const message = `ingest: ${results.length} articles (${tally.done} done, ${tally.skipped} skipped, ${tally.failed} failed)`;
    // Only commit librarian-owned outputs. Excludes the sqlite db (gitignored
    // anyway), excludes freshly-collected matcha files (intake's job),
    // excludes raw/inbox/migrated/* (one-time migration is its own concern).
    const result = await git.commit(message, ['log.md', 'index.md', 'wiki/']);
    if (result.committed) {
      yield {
        type: 'agent_activity',
        agent: 'commit-local',
        action: 'committed',
        detail: `${result.sha?.slice(0, 7)} — ${message}`,
      };
    } else {
      yield {
        type: 'agent_activity',
        agent: 'commit-local',
        action: 'noop',
        detail: 'no changes to commit',
      };
    }
  },
});

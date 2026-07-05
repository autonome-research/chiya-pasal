/**
 * Librarian phases. Sources are first-class wiki pages, topics are routing
 * nodes. See src/librarian.ts for the phase composition.
 *
 * Phases below are organized in execution order:
 *   - reapStale + loadBatch: queue management.
 *   - batchEnrich + batchExtractRefs: pre-fan-out prep (full-text fetch + ref
 *     extraction). No LLM, no per-article work yet.
 *   - planArticleTree/applyArticlePlans live in dedicated modules and handle
 *     agent planning plus serial deterministic vault/DB mutation.
 *   - mergeMetadata + commitLocal close out the batch.
 */

import {
  requireCtx,
  type Phase,
} from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';

import { ArticleStore } from '../shared/article-store.js';
import type {
  EnrichedArticle,
  ExtractedRefs,
  LibrarianCtx,
} from '../shared/librarian-types.js';
import type { GitOps } from '../tools/git.js';
import type { VaultFs } from '../tools/vault.js';
import { extractArxivIds, extractDois } from '../shared/refs.js';

// ---------------------------------------------------------------------------
// reapStale + loadBatch — queue management before the fan-out.
// ---------------------------------------------------------------------------

// Articles spend ~50-85s in 'processing' under normal v3 load (router →
// 4 scouts → reviewer → summary → writes). The in-pipeline soft deadline
// is 8 min and the systemd hard-kill is 20 min, so any row still
// 'processing' beyond 20 min is necessarily a crash victim. acquireExclusive
// guarantees no concurrent librarian runs, so we can't reap a live row by
// accident. Setting the reap threshold modestly above the hard-kill window
// makes recovery take 1-2 timer ticks (10-min cadence) instead of 6.
const STALE_PROCESSING_MINUTES = 20;

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

export interface LoadBatchOptions {
  /** Preview pending rows without moving them to processing. */
  dryRun?: boolean;
}

export const loadBatch = (store: ArticleStore, options: LoadBatchOptions = {}): Phase<LibrarianCtx> => ({
  name: 'load-batch',
  async *run(ctx) {
    const dryRun = options.dryRun ?? ctx.dryRun ?? false;
    const batch = store.listPending(ctx.batchSize);
    ctx.batch = batch;
    if (!dryRun) {
      for (const row of batch) store.markProcessing(row.id);
    }
    if (batch.length === 0) ctx.stop = { reason: 'queue-empty' };
    yield {
      type: 'phase',
      phase: 'load-batch',
      detail: dryRun
        ? `${batch.length} article(s) previewed (status left as 'pending')`
        : `${batch.length} article(s) pulled (status='processing')`,
      counts: {
        batch: batch.length,
        totalPending: store.countByStatus().pending + (dryRun ? 0 : batch.length),
        dryRun: dryRun ? 1 : 0,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// batchEnrich — fan-out HTTP fetches for articles whose snippet is too thin
// to classify or summarize.
// ---------------------------------------------------------------------------

const ENRICH_SNIPPET_THRESHOLD = 200;
const ENRICH_CONCURRENCY = 4;
const ENRICH_FETCH_TIMEOUT_MS = 15_000;
const ENRICH_USER_AGENT = 'chiya-librarian/2.0';

/**
 * Decide whether a row needs an HTTP fetch. Skip when the snippet is already
 * fat enough OR when there's no http(s) URL we can simply GET.
 */
export function shouldFetch(article: { snippet: string | null; url: string | null }): boolean {
  const { snippet, url } = article;
  if (snippet !== null && snippet.length >= ENRICH_SNIPPET_THRESHOLD) return false;
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

// HTML stripping now lives in the shared fulltext module (the shared enrich
// phase is its long-term home). Imported + re-exported here because this
// phase and its tests still consume it until the librarian's own enrich
// step is retired in the multi-tenant cutover.
import { htmlToText } from '../shared/fulltext.js';
export { htmlToText };

interface FetchOutcome {
  body: string;
  enriched: boolean;
  enrichError?: string;
}

async function fetchOneArticle(
  url: string,
  fallback: string,
  outerSignal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENRICH_FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': ENRICH_USER_AGENT, accept: 'text/html, text/plain;q=0.9, */*;q=0.5' },
    });
    if (!res.ok) {
      return { body: fallback, enriched: false, enrichError: `http ${res.status}` };
    }
    const raw = await res.text();
    const text = htmlToText(raw);
    if (!text) return { body: fallback, enriched: false, enrichError: 'empty body' };
    return { body: text, enriched: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { body: fallback, enriched: false, enrichError: msg.slice(0, 200) };
  } finally {
    clearTimeout(timeout);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

export const batchEnrich = (): Phase<LibrarianCtx> => ({
  name: 'batch-enrich',
  async *run(ctx) {
    const batch = requireCtx(ctx, 'batch', 'batch-enrich');

    const enriched: EnrichedArticle[] = new Array(batch.length);
    let fetched = 0;
    let skipped = 0;
    let errors = 0;

    // Pre-fill skips so the fanout only sees rows that actually need a GET.
    type FetchSlot = { idx: number; articleId: number; url: string; fallback: string };
    const slots: FetchSlot[] = [];
    for (let i = 0; i < batch.length; i++) {
      const a = batch[i]!;
      const fallback = a.snippet ?? '';
      if (!shouldFetch(a)) {
        enriched[i] = { articleId: a.id, body: fallback, enriched: false };
        skipped++;
        continue;
      }
      slots.push({ idx: i, articleId: a.id, url: a.url!, fallback });
    }

    if (slots.length > 0) {
      const results = await boundedFanout({
        items: slots,
        concurrency: ENRICH_CONCURRENCY,
        mode: 'collect' as const,
        signal: ctx.signal,
        runner: async (slot, _i, signal) => fetchOneArticle(slot.url, slot.fallback, signal),
      });
      for (let j = 0; j < slots.length; j++) {
        const slot = slots[j]!;
        const r = results[j]!;
        if (r.ok) {
          const o = r.value;
          enriched[slot.idx] = {
            articleId: slot.articleId,
            body: o.body,
            enriched: o.enriched,
            ...(o.enrichError ? { enrichError: o.enrichError } : {}),
          };
          if (o.enriched) fetched++;
          else errors++;
        } else {
          // boundedFanout cancelled this slot (e.g. ctx.signal aborted before dispatch).
          enriched[slot.idx] = {
            articleId: slot.articleId,
            body: slot.fallback,
            enriched: false,
            enrichError: r.error.message.slice(0, 200),
          };
          errors++;
        }
      }
    }

    ctx.enriched = enriched;
    yield {
      type: 'phase',
      phase: 'batch-enrich',
      detail: `${enriched.length} article(s); ${fetched} fetched / ${skipped} skipped${errors > 0 ? ' / ' + errors + ' errors' : ''}`,
      counts: { articles: enriched.length, fetched, skipped, errors },
    };
  },
});

// ---------------------------------------------------------------------------
// batchExtractRefs — pure-CPU fan-out applying refs.ts to each article body.
// ---------------------------------------------------------------------------

export const batchExtractRefs = (): Phase<LibrarianCtx> => ({
  name: 'batch-extract-refs',
  async *run(ctx) {
    const enriched = requireCtx(ctx, 'enriched', 'batch-extract-refs');
    const refs: ExtractedRefs[] = enriched.map((e) => ({
      articleId: e.articleId,
      arxivIds: extractArxivIds(e.body),
      dois: extractDois(e.body),
    }));
    ctx.refs = refs;
    const totalRefs = refs.reduce((acc, r) => acc + r.arxivIds.length + r.dois.length, 0);
    yield {
      type: 'phase',
      phase: 'batch-extract-refs',
      detail: `${refs.length} article(s) / ${totalRefs} ref(s) extracted`,
      counts: { articles: refs.length, refs: totalRefs },
    };
  },
});


// ---------------------------------------------------------------------------
// Agent planning and deterministic apply now live in:
//   - librarian-planner.ts  (router → scouts → reviewer → summary, no writes)
//   - librarian-apply.ts    (serial revalidation + vault/DB mutations)
//
// This file retains the batch prep and closing phases.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mergeMetadata — append per-article logEntries to log.md. index.md is not
// maintained per-article (separate lint).
// ---------------------------------------------------------------------------

export const mergeMetadata = (vault: VaultFs): Phase<LibrarianCtx> => ({
  name: 'merge-metadata',
  async *run(ctx) {
    const results = requireCtx(ctx, 'results', 'merge-metadata');
    if (ctx.dryRun) {
      yield {
        type: 'phase',
        phase: 'merge-metadata',
        detail: 'dry-run: skipped log.md append',
        counts: { log: 0, dryRun: 1 },
      };
      return;
    }
    const logEntries = results.map((r) => r.logEntry).filter((e): e is string => Boolean(e));
    if (logEntries.length > 0) {
      const block = logEntries.map((e) => `## ${e.replace(/^## ?/, '')}`).join('\n\n');
      await vault.append('log.md', '\n' + block + '\n');
    }
    yield {
      type: 'phase',
      phase: 'merge-metadata',
      detail: `${logEntries.length} log entries`,
      counts: { log: logEntries.length, dryRun: 0 },
    };
  },
});

// ---------------------------------------------------------------------------
// commitLocal — single local commit per run, scoped to source/topic/log paths.
// ---------------------------------------------------------------------------

export const commitLocal = (git: GitOps): Phase<LibrarianCtx> => ({
  name: 'commit-local',
  async *run(ctx) {
    const results = requireCtx(ctx, 'results', 'commit-local');
    if (ctx.dryRun) {
      yield {
        type: 'agent_activity',
        agent: 'commit-local',
        action: 'noop',
        detail: 'dry-run: skipped git commit',
      };
      return;
    }
    const tally = results.reduce(
      (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
      { done: 0, skipped: 0, failed: 0 } as Record<string, number>,
    );
    const message = `ingest: ${results.length} articles (${tally.done} done, ${tally.skipped} skipped, ${tally.failed} failed)`;
    const result = await git.commit(message, ['log.md', 'wiki/sources/', 'wiki/topics/']);
    yield {
      type: 'agent_activity',
      agent: 'commit-local',
      action: result.committed ? 'committed' : 'noop',
      detail: result.committed
        ? `${result.sha?.slice(0, 7)} — ${message}`
        : 'no changes to commit',
    };
  },
});

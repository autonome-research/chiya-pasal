/**
 * Librarian phases. Sources are first-class wiki pages, topics are routing
 * nodes. See src/librarian.ts for the phase composition.
 *
 * Phases below are organized in execution order:
 *   - reapStale + loadBatch: queue management.
 *   - planArticleTree/applyArticlePlans live in dedicated modules and handle
 *     agent planning plus serial deterministic vault/DB mutation.
 *   - mergeMetadata + commitLocal close out the batch.
 *
 * Fetching and summarization live in the SHARED pipeline (src/shared-pipeline.ts)
 * — routed rows arrive with the rich summary in the snippet column and refs
 * pre-extracted. The per-user librarian only curates.
 */

import {
  requireCtx,
  type Phase,
} from 'thread-phase';

import { ArticleStore } from '../shared/article-store.js';
import type { LibrarianCtx } from '../shared/librarian-types.js';
import type { GitOps } from '../tools/git.js';
import type { VaultFs } from '../tools/vault.js';

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
// Agent planning and deterministic apply live in:
//   - librarian-planner.ts  (router → scouts → reviewer, no writes)
//   - librarian-apply.ts    (serial revalidation + vault/DB mutations)
//
// This file retains queue management and the closing phases.
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

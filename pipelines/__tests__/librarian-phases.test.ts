import { describe, it, expect } from 'vitest';

import { loadBatch } from '../src/phases/librarian-phases.js';
import type { LibrarianCtx } from '../src/shared/librarian-types.js';
import type { ArticleRow, ArticleStore } from '../src/shared/article-store.js';

// Drain a phase generator, collecting yielded events. Ignores typing of the
// event union — we only care about basic shape in these tests.
async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function makeCtx(partial: Partial<LibrarianCtx>): LibrarianCtx {
  return {
    cache: new Map() as unknown as LibrarianCtx['cache'],
    batchSize: 10,
    signal: new AbortController().signal,
    ...partial,
  } as LibrarianCtx;
}

function mkRow(over: Partial<ArticleRow>): ArticleRow {
  return {
    id: 1,
    url: null,
    urlHash: null,
    title: 'untitled',
    titleHash: 'h',
    source: null,
    field: null,
    snippet: null,
    collectedAt: new Date(0),
    collectedFrom: 'test',
    status: 'pending',
    statusReason: null,
    processedAt: null,
    pagePaths: [],
    refsArxiv: null,
    refsDoi: null,
    sharedStableId: null,
    routedSimilarity: null,
    ...over,
  };
}

describe('loadBatch', () => {
  it('dry-run mode lists pending rows without marking them processing', async () => {
    const row = mkRow({ id: 42 });
    let markedProcessing = false;
    const store = {
      listPending: () => [row],
      markProcessing: () => { markedProcessing = true; },
      countByStatus: () => ({ pending: 1, processing: 0, done: 0, skipped: 0, failed: 0 }),
    } as unknown as ArticleStore;
    const ctx = makeCtx({ dryRun: true });
    const events = await drain(loadBatch(store, { dryRun: true }).run(ctx));

    expect(ctx.batch).toEqual([row]);
    expect(markedProcessing).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'phase',
      phase: 'load-batch',
      counts: { batch: 1, totalPending: 1, dryRun: 1 },
    });
  });

  it('live mode marks each pulled row processing', async () => {
    const rows = [mkRow({ id: 1 }), mkRow({ id: 2, titleHash: 'h2' })];
    const marked: number[] = [];
    const store = {
      listPending: () => rows,
      markProcessing: (id: number) => marked.push(id),
      countByStatus: () => ({ pending: 0, processing: 2, done: 0, skipped: 0, failed: 0 }),
    } as unknown as ArticleStore;
    const ctx = makeCtx({});
    await drain(loadBatch(store).run(ctx));
    expect(marked).toEqual([1, 2]);
  });

  it('empty queue sets the stop signal', async () => {
    const store = {
      listPending: () => [],
      markProcessing: () => undefined,
      countByStatus: () => ({ pending: 0, processing: 0, done: 0, skipped: 0, failed: 0 }),
    } as unknown as ArticleStore;
    const ctx = makeCtx({});
    await drain(loadBatch(store).run(ctx));
    expect(ctx.stop).toMatchObject({ reason: 'queue-empty' });
  });
});

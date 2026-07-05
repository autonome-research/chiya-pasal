import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';
import type OpenAI from 'openai';

import {
  callRichSummary,
  summarizeEnriched,
  type SharedSummarizer,
} from '../../src/phases/shared/summarize.js';
import { SharedArticleStore } from '../../src/shared/shared-article-store.js';
import type { SharedPipelineCtx } from '../../src/shared/shared-pipeline-types.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function makeCtx(): SharedPipelineCtx {
  return { cache: new PipelineCache(), signal: new AbortController().signal };
}

const GOOD_SUMMARY = '## Overview\nThe paper proposes X.\n\n## Findings\nIt works.';

let dir: string;
let store: SharedArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-summ-'));
  store = new SharedArticleStore(join(dir, 'articles.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(stableId: string, opts: { fulltext?: string | null; abstract?: string | null } = {}): void {
  store.upsertCollected({
    stableId,
    url: `https://example.com/${stableId}`,
    title: `Article ${stableId}`,
    source: 'test',
    field: 'AI/ML',
    queryLabels: ['AI/ML'],
    abstract: opts.abstract === undefined ? 'an abstract' : opts.abstract,
  });
  if (opts.fulltext !== undefined && opts.fulltext !== null) {
    store.markEnriched(stableId, opts.fulltext, [], []);
  } else {
    store.markEnrichFailed(stableId, 'fetch failed');
  }
}

describe('summarizeEnriched phase', () => {
  it('summarizes enriched rows and enrich-failed rows (abstract fallback)', async () => {
    seed('a1', { fulltext: 'full text body' });
    seed('a2', { fulltext: null }); // enrich-failed, has abstract

    const seen: Array<{ id: string; hadFulltext: boolean }> = [];
    const summarizer: SharedSummarizer = async (article) => {
      seen.push({ id: article.stableId, hadFulltext: article.fulltext !== null });
      return GOOD_SUMMARY;
    };

    const ctx = makeCtx();
    await drain(summarizeEnriched(store, fakeClients(), summarizer).run(ctx));

    expect(ctx.summarizeCounts).toEqual({ summarized: 2, failed: 0, noText: 0 });
    expect(store.findByStableId('a1')!.status).toBe('summarized');
    expect(store.findByStableId('a1')!.summary).toBe(GOOD_SUMMARY);
    expect(store.findByStableId('a2')!.status).toBe('summarized');
    expect(seen.find((s) => s.id === 'a2')!.hadFulltext).toBe(false);
  });

  it('marks rows with neither fulltext nor abstract as failed (no-text)', async () => {
    seed('empty', { fulltext: null, abstract: null });
    const ctx = makeCtx();
    await drain(
      summarizeEnriched(store, fakeClients(), async () => GOOD_SUMMARY).run(ctx),
    );
    expect(ctx.summarizeCounts).toEqual({ summarized: 0, failed: 0, noText: 1 });
    const row = store.findByStableId('empty')!;
    expect(row.status).toBe('failed');
    expect(row.statusReason).toContain('no-text');
  });

  it('records summarizer throws as failed rows without aborting the batch', async () => {
    seed('ok', { fulltext: 'text' });
    seed('boom', { fulltext: 'text' });
    const summarizer: SharedSummarizer = async (a) => {
      if (a.stableId === 'boom') throw new Error('model exploded');
      return GOOD_SUMMARY;
    };
    const ctx = makeCtx();
    await drain(summarizeEnriched(store, fakeClients(), summarizer).run(ctx));
    expect(ctx.summarizeCounts).toEqual({ summarized: 1, failed: 1, noText: 0 });
    expect(store.findByStableId('boom')!.status).toBe('failed');
    expect(store.findByStableId('boom')!.statusReason).toContain('model exploded');
  });

  it('no-op when nothing is enriched', async () => {
    const ctx = makeCtx();
    await drain(
      summarizeEnriched(store, fakeClients(), async () => GOOD_SUMMARY).run(ctx),
    );
    expect(ctx.summarizeCounts).toEqual({ summarized: 0, failed: 0, noText: 0 });
  });
});

describe('callRichSummary contract', () => {
  it('rejects output missing the section structure', async () => {
    const client = fakeStreamingClient('This is just prose without sections.');
    seedRowAnd(async (row) => {
      await expect(
        callRichSummary(row, { client, model: 'fake' }),
      ).rejects.toThrow(/missing section structure/);
    });
  });

  it('throws on truncation (finishReason length)', async () => {
    const client = fakeStreamingClient('## Overview\nCut off mid', 'length');
    await seedRowAnd(async (row) => {
      await expect(callRichSummary(row, { client, model: 'fake' })).rejects.toThrow(/truncated/);
    });
  });

  it('returns structured summaries as-is', async () => {
    const client = fakeStreamingClient(GOOD_SUMMARY);
    await seedRowAnd(async (row) => {
      await expect(callRichSummary(row, { client, model: 'fake' })).resolves.toBe(GOOD_SUMMARY);
    });
  });

  async function seedRowAnd(fn: (row: import('../../src/shared/shared-article-store.js').SharedArticleRow) => Promise<void>): Promise<void> {
    seed('contract', { fulltext: 'body text' });
    const row = store.findByStableId('contract')!;
    await fn(row);
  }
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeClients(): { client: OpenAI; model: string } {
  return { client: {} as unknown as OpenAI, model: 'fake-model' };
}

function fakeStreamingClient(text: string, finishReason: string = 'stop'): OpenAI {
  const chunks = [
    { choices: [{ delta: { content: text }, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: finishReason, index: 0 }] },
  ];
  const stream = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
  return {
    chat: { completions: { create: async () => stream } },
  } as unknown as OpenAI;
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';
import type OpenAI from 'openai';

import {
  callRichSummary,
  failsQualityGate,
  parseSummaryOutput,
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

    expect(ctx.summarizeCounts).toEqual({ summarized: 2, failed: 0, noText: 0, rejected: 0 });
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
    expect(ctx.summarizeCounts).toEqual({ summarized: 0, failed: 0, noText: 1, rejected: 0 });
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
    expect(ctx.summarizeCounts).toEqual({ summarized: 1, failed: 1, noText: 0, rejected: 0 });
    expect(store.findByStableId('boom')!.status).toBe('failed');
    expect(store.findByStableId('boom')!.statusReason).toContain('model exploded');
  });

  it('no-op when nothing is enriched', async () => {
    const ctx = makeCtx();
    await drain(
      summarizeEnriched(store, fakeClients(), async () => GOOD_SUMMARY).run(ctx),
    );
    expect(ctx.summarizeCounts).toEqual({ summarized: 0, failed: 0, noText: 0, rejected: 0 });
  });
});

const ASSESSED = (rigor: number, kind: string): string =>
  `${GOOD_SUMMARY}\n\n## Assessment\nrigor: ${rigor}/5\nevidence: 3/5\nkind: ${kind}`;

describe('parseSummaryOutput', () => {
  it('splits summary from a well-formed assessment', () => {
    const { summary, quality } = parseSummaryOutput(ASSESSED(4, 'research'));
    expect(summary).toBe(GOOD_SUMMARY);
    expect(quality).toEqual({ rigor: 4, evidence: 3, kind: 'research' });
  });

  it('returns null quality when the section is missing (fail-open)', () => {
    const { summary, quality } = parseSummaryOutput(GOOD_SUMMARY);
    expect(summary).toBe(GOOD_SUMMARY);
    expect(quality).toBeNull();
  });

  it('returns null quality on malformed fields but still strips the section', () => {
    const text = `${GOOD_SUMMARY}\n\n## Assessment\nrigor: high\nevidence: 3/5\nkind: research`;
    const { summary, quality } = parseSummaryOutput(text);
    expect(summary).toBe(GOOD_SUMMARY);
    expect(quality).toBeNull();
  });

  it('rejects out-of-vocabulary kind values', () => {
    const { quality } = parseSummaryOutput(ASSESSED(4, 'masterpiece'));
    expect(quality).toBeNull();
  });
});

describe('failsQualityGate', () => {
  it('passes unassessed articles (fail-open)', () => {
    expect(failsQualityGate(null)).toBe(false);
  });
  it('drops announcements and other regardless of rigor', () => {
    expect(failsQualityGate({ rigor: 5, evidence: 5, kind: 'announcement' })).toBe(true);
    expect(failsQualityGate({ rigor: 5, evidence: 5, kind: 'other' })).toBe(true);
  });
  it('drops rigor 1, passes rigor 2+ research/survey/position', () => {
    expect(failsQualityGate({ rigor: 1, evidence: 1, kind: 'research' })).toBe(true);
    expect(failsQualityGate({ rigor: 2, evidence: 1, kind: 'research' })).toBe(false);
    expect(failsQualityGate({ rigor: 2, evidence: 2, kind: 'survey' })).toBe(false);
    expect(failsQualityGate({ rigor: 3, evidence: 2, kind: 'position' })).toBe(false);
  });
});

describe('summarizeEnriched quality gating', () => {
  it('routes junk to rejected-quality, storing summary + assessment for tuning', async () => {
    seed('junk', { fulltext: 'buy our new model API today' });
    seed('good', { fulltext: 'real research text' });
    const summarizer: SharedSummarizer = async (a) =>
      a.stableId === 'junk' ? ASSESSED(1, 'announcement') : ASSESSED(4, 'research');

    const ctx = makeCtx();
    await drain(summarizeEnriched(store, fakeClients(), summarizer).run(ctx));

    expect(ctx.summarizeCounts).toEqual({ summarized: 1, failed: 0, noText: 0, rejected: 1 });
    const junk = store.findByStableId('junk')!;
    expect(junk.status).toBe('rejected-quality');
    expect(junk.statusReason).toContain('announcement');
    expect(junk.summary).toBe(GOOD_SUMMARY); // stored for later tuning
    expect(junk.quality).toEqual({ rigor: 1, evidence: 3, kind: 'announcement' });

    const good = store.findByStableId('good')!;
    expect(good.status).toBe('summarized');
    expect(good.summary).toBe(GOOD_SUMMARY); // assessment stripped
    expect(good.quality).toEqual({ rigor: 4, evidence: 3, kind: 'research' });
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

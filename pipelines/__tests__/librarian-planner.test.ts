import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';
import type OpenAI from 'openai';

import {
  parseRegistryJson,
  planArticleTree,
  refsForArticle,
  type PerArticleDeps,
} from '../src/phases/librarian-planner.js';
import { ArticleStore, type ArticleRow } from '../src/shared/article-store.js';
import type { LibrarianCtx } from '../src/shared/librarian-types.js';
import { reviewerFailureReason, type ReviewerOutput } from '../src/phases/reviewer.js';
import { VaultFs } from '../src/tools/vault.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const REVIEWER_OUT: ReviewerOutput = {
  topics: [{ slug: 'llm-evaluation', why: 'relevant' }],
  cites: [],
  related: [],
  entities: [],
};

/** DI runners that record the body/refs they were handed. */
function recordingDeps(record: { bodies: string[]; refs: Array<{ arxivIds: string[]; dois: string[] }> }): PerArticleDeps {
  const scoutOut = { surfacedPages: [] };
  return {
    router: async (input) => {
      record.bodies.push(input.body);
      record.refs.push({ arxivIds: input.refs.arxivIds, dois: input.refs.dois });
      return {
        topicScoutTask: 't',
        sourceScoutTask: 's',
        entityScoutTask: 'e',
        citeTrackerTask: 'c',
      };
    },
    topicScout: async () => scoutOut,
    sourceScout: async () => scoutOut,
    entityScout: async () => scoutOut,
    citeTracker: async () => scoutOut,
    reviewer: async () => REVIEWER_OUT,
  };
}

const clients = { toolsClient: {} as unknown as OpenAI, toolsModel: 'fake' };

let dir: string;
let vault: VaultFs;
let store: ArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-planner-'));
  mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
  vault = new VaultFs(dir);
  store = new ArticleStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctxWith(batch: ArticleRow[]): LibrarianCtx {
  return {
    cache: new PipelineCache(),
    batchSize: 10,
    signal: new AbortController().signal,
    batch,
  };
}

describe('refsForArticle', () => {
  const base = {
    id: 1, url: 'https://arxiv.org/abs/2606.1', urlHash: 'x', title: 'T', titleHash: 'h',
    source: null, field: null, snippet: null, collectedAt: new Date(), collectedFrom: 't',
    status: 'processing', statusReason: null, processedAt: null, pagePaths: [],
    sharedStableId: null, routedSimilarity: null,
  } as const;

  it('prefers the routed columns when present', () => {
    const row = { ...base, refsArxiv: ['2601.00001'], refsDoi: ['10.1/x'] } as ArticleRow;
    const refs = refsForArticle(row, 'body mentioning arXiv:9999.99999');
    expect(refs.arxivIds).toEqual(['2601.00001']);
    expect(refs.dois).toEqual(['10.1/x']);
  });

  it('falls back to a regex pass over the body for legacy rows', () => {
    const row = { ...base, refsArxiv: null, refsDoi: null } as ArticleRow;
    const refs = refsForArticle(row, 'See arXiv:2605.03823 and 10.1038/s41586-020-2649-2.');
    expect(refs.arxivIds).toEqual(['2605.03823']);
    expect(refs.dois).toEqual(['10.1038/s41586-020-2649-2']);
  });

  it('routed empty arrays are respected (no fallback firing)', () => {
    const row = { ...base, refsArxiv: [], refsDoi: [] } as ArticleRow;
    const refs = refsForArticle(row, 'text with arXiv:2605.03823');
    expect(refs.arxivIds).toEqual([]);
  });
});

describe('planArticleTree (routed-row consumption)', () => {
  it('feeds the snippet (rich summary) as body and column refs to the agents', async () => {
    const r = store.upsertRouted({
      title: 'Routed article',
      url: 'https://arxiv.org/abs/2606.33333',
      source: 'arXiv',
      field: 'AI/ML',
      summary: '## Overview\nRouted rich summary.',
      refsArxiv: ['2601.00001'],
      refsDoi: [],
      sharedStableId: 'arxiv-2606-33333',
      routedSimilarity: 0.7,
    });
    store.markProcessing(r.id!);
    const row = store.getById(r.id!)!;

    const record = { bodies: [] as string[], refs: [] as Array<{ arxivIds: string[]; dois: string[] }> };
    const ctx = ctxWith([row]);
    await drain(planArticleTree(clients, vault, store, recordingDeps(record)).run(ctx));

    expect(record.bodies).toEqual(['## Overview\nRouted rich summary.']);
    expect(record.refs).toEqual([{ arxivIds: ['2601.00001'], dois: [] }]);

    const plan = ctx.articlePlans![0]!;
    expect(plan.outcome).toBe('planned');
    if (plan.outcome === 'planned') {
      expect(plan.plan.summary).toBe('## Overview\nRouted rich summary.');
      expect(plan.plan.sourcePath).toBe('wiki/sources/arxiv-2606-33333.md');
    }
  });

  function routedRow(url: string, stableId: string, summary = '## Overview\nSummary.'): ArticleRow {
    const r = store.upsertRouted({
      title: 'Routed article',
      url,
      source: 'arXiv',
      field: 'AI/ML',
      summary,
      refsArxiv: [],
      refsDoi: [],
      sharedStableId: stableId,
      routedSimilarity: 0.7,
    });
    store.markProcessing(r.id!);
    return store.getById(r.id!)!;
  }

  it('defers with an attempt marker when the reviewer fails', async () => {
    const row = routedRow('https://arxiv.org/abs/2606.44444', 'arxiv-2606-44444');
    const deps = recordingDeps({ bodies: [], refs: [] });
    deps.reviewer = async () => ({ topics: [], cites: [], related: [], entities: [], error: 'truncated' });

    const ctx = ctxWith([row]);
    const events = await drain(planArticleTree(clients, vault, store, deps).run(ctx));

    expect(ctx.articlePlans![0]).toEqual({
      articleId: row.id,
      outcome: 'deferred',
      reason: 'reviewer-failed (attempt 1): truncated',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'phase',
      counts: { deferred: 1, reviewerDeferred: 1 },
    });
  });

  it('increments the attempt from the row status_reason on later runs', async () => {
    const base = routedRow('https://arxiv.org/abs/2606.55555', 'arxiv-2606-55555');
    const row = { ...base, statusReason: reviewerFailureReason(1, 'truncated') };
    const deps = recordingDeps({ bodies: [], refs: [] });
    deps.reviewer = async () => ({ topics: [], cites: [], related: [], entities: [], error: 'boom' });

    const ctx = ctxWith([row]);
    await drain(planArticleTree(clients, vault, store, deps).run(ctx));

    expect(ctx.articlePlans![0]).toMatchObject({
      outcome: 'deferred',
      reason: 'reviewer-failed (attempt 2): boom',
    });
  });

  it('third attempt falls through to a degraded plan instead of deferring forever', async () => {
    const base = routedRow('https://arxiv.org/abs/2606.66666', 'arxiv-2606-66666');
    const row = { ...base, statusReason: reviewerFailureReason(2, 'truncated') };
    const deps = recordingDeps({ bodies: [], refs: [] });
    deps.reviewer = async () => ({ topics: [], cites: [], related: [], entities: [], error: 'truncated' });

    const ctx = ctxWith([row]);
    await drain(planArticleTree(clients, vault, store, deps).run(ctx));

    const plan = ctx.articlePlans![0]!;
    expect(plan.outcome).toBe('planned');
    if (plan.outcome === 'planned') {
      expect(plan.plan.reviewer.error).toBe('truncated');
    }
  });

  it('defers an error-blob summary without invoking any agents', async () => {
    const res = store.upsertPending({
      title: 'Legacy blob', url: 'https://arxiv.org/abs/2606.77777', source: null, field: null,
      snippet: '{"_error": true, "message": "summarize exploded"}', collectedFrom: 't',
    });
    store.markProcessing(res.id!);
    const record = { bodies: [] as string[], refs: [] as Array<{ arxivIds: string[]; dois: string[] }> };

    const ctx = ctxWith([store.getById(res.id!)!]);
    await drain(planArticleTree(clients, vault, store, recordingDeps(record)).run(ctx));

    expect(ctx.articlePlans![0]).toEqual({
      articleId: res.id,
      outcome: 'deferred',
      reason: 'summary-unavailable',
    });
    expect(record.bodies).toEqual([]);
  });

  it('defers an empty/whitespace body as summary-unavailable', async () => {
    const res = store.upsertPending({
      title: 'No body', url: 'https://arxiv.org/abs/2606.88888', source: null, field: null,
      snippet: '   ', collectedFrom: 't',
    });
    store.markProcessing(res.id!);

    const ctx = ctxWith([store.getById(res.id!)!]);
    await drain(planArticleTree(clients, vault, store, recordingDeps({ bodies: [], refs: [] })).run(ctx));

    expect(ctx.articlePlans![0]).toMatchObject({ outcome: 'deferred', reason: 'summary-unavailable' });
  });

  it('skips articles without a stable id', async () => {
    const res = store.upsertPending({
      title: 'No URL', url: null, source: null, field: null,
      snippet: 'x', collectedFrom: 't',
    });
    store.markProcessing(res.id!);
    const row = store.getById(res.id!)!;

    const ctx = ctxWith([row]);
    await drain(planArticleTree(clients, vault, store, recordingDeps({ bodies: [], refs: [] })).run(ctx));
    expect(ctx.articlePlans![0]).toMatchObject({ outcome: 'skipped', reason: 'no-url-no-stable-id' });
  });
});

describe('planArticleTree — run-level topic vocabulary', () => {
  function routed(url: string, stableId: string): ArticleRow {
    const r = store.upsertRouted({
      title: 'Vocabulary article',
      url,
      source: 'arXiv',
      field: 'AI/ML',
      summary: '## Overview\nSummary.',
      refsArxiv: [],
      refsDoi: [],
      sharedStableId: stableId,
      routedSimilarity: 0.7,
    });
    store.markProcessing(r.id!);
    return store.getById(r.id!)!;
  }

  function seedTopics(): void {
    mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
    writeFileSync(
      join(dir, 'wiki/topics/llm-evaluation.md'),
      '---\ntype: topic\nclusters: [ai-ml]\n---\n\n# Llm Evaluation\n\nHow to assess models.\n\n## Member sources\n\n- [[wiki/sources/arxiv-1]] — A (2026-01-01)\n',
    );
    writeFileSync(
      join(dir, 'wiki/topics/quantum-sensing.md'),
      '---\ntype: topic\nclusters: [physics]\n---\n\n# Quantum Sensing\n\nSensing with coherence.\n\n## Member sources\n\n_None yet._\n',
    );
  }

  /** Captures the vocabulary each agent was handed. */
  function capturingDeps(seen: { scout: (string | undefined)[]; reviewer: (string | undefined)[] }): PerArticleDeps {
    const deps = recordingDeps({ bodies: [], refs: [] });
    deps.topicScout = async (input) => {
      seen.scout.push(input.vocabulary);
      return { surfacedPages: [] };
    };
    deps.reviewer = async (input) => {
      seen.reviewer.push(input.vocabulary);
      return REVIEWER_OUT;
    };
    return deps;
  }

  it('scans the vault once and hands the vocabulary to the topic scout and the reviewer', async () => {
    seedTopics();
    const row = routed('https://arxiv.org/abs/2607.10001', 'arxiv-2607-10001');
    const seen = { scout: [] as (string | undefined)[], reviewer: [] as (string | undefined)[] };

    const ctx = ctxWith([row]);
    const events = await drain(planArticleTree(clients, vault, store, capturingDeps(seen)).run(ctx));

    expect(seen.reviewer[0]).toContain('llm-evaluation');
    expect(seen.reviewer[0]).toContain('quantum-sensing');
    expect(seen.reviewer[0]).toContain('ai-ml (1):');
    expect(seen.scout[0]).toContain('llm-evaluation');
    expect(events.at(-1)).toMatchObject({ counts: { vocabularyTopics: 2 } });
    expect((events.at(-1) as { detail: string }).detail).toContain('vocab-topics=2');
  });

  it('prefers the emitted registry.json over a live scan', async () => {
    seedTopics();
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({
        generatedAt: '2026-08-01T00:00:00.000Z',
        clusters: [{ name: 'emitted-cluster', topicCount: 1 }],
        topics: [{ slug: 'from-registry-json', title: 'From Registry', clusters: ['emitted-cluster'], memberCount: 3 }],
      }),
    );
    const row = routed('https://arxiv.org/abs/2607.10002', 'arxiv-2607-10002');
    const seen = { scout: [] as (string | undefined)[], reviewer: [] as (string | undefined)[] };

    await drain(planArticleTree(clients, vault, store, capturingDeps(seen)).run(ctxWith([row])));

    expect(seen.reviewer[0]).toContain('from-registry-json');
    expect(seen.reviewer[0]).not.toContain('llm-evaluation');
  });

  it('falls back to a live scan when registry.json is unparseable', async () => {
    seedTopics();
    writeFileSync(join(dir, 'registry.json'), 'not json at all');
    const row = routed('https://arxiv.org/abs/2607.10003', 'arxiv-2607-10003');
    const seen = { scout: [] as (string | undefined)[], reviewer: [] as (string | undefined)[] };

    await drain(planArticleTree(clients, vault, store, capturingDeps(seen)).run(ctxWith([row])));

    expect(seen.reviewer[0]).toContain('llm-evaluation');
  });

  it('plans blind (empty vocabulary) instead of failing when the registry cannot be loaded', async () => {
    const row = routed('https://arxiv.org/abs/2607.10004', 'arxiv-2607-10004');
    const seen = { scout: [] as (string | undefined)[], reviewer: [] as (string | undefined)[] };
    const deps = capturingDeps(seen);
    deps.loadRegistry = () => { throw new Error('registry exploded'); };

    const ctx = ctxWith([row]);
    const events = await drain(planArticleTree(clients, vault, store, deps).run(ctx));

    expect(ctx.articlePlans![0]).toMatchObject({ outcome: 'planned' });
    expect(seen.reviewer[0]).toBe('');
    expect(events.at(-1)).toMatchObject({ counts: { vocabularyTopics: 0 } });
  });

  it('an absent wiki/topics directory yields an empty vocabulary, not a crash', async () => {
    const row = routed('https://arxiv.org/abs/2607.10005', 'arxiv-2607-10005');
    const seen = { scout: [] as (string | undefined)[], reviewer: [] as (string | undefined)[] };

    await drain(planArticleTree(clients, vault, store, capturingDeps(seen)).run(ctxWith([row])));

    expect(seen.reviewer[0]).toBe('');
  });
});

describe('parseRegistryJson', () => {
  it('round-trips the emitter contract and defaults missing fields', () => {
    const reg = parseRegistryJson(JSON.stringify({
      generatedAt: '2026-08-01T00:00:00.000Z',
      clusters: [{ name: 'ai-ml', topicCount: 2 }],
      topics: [{ slug: 'a' }, { slug: 'b', memberCount: 4, clusters: ['ai-ml'] }],
    }));
    expect(reg?.topics).toEqual([
      { slug: 'a', title: 'a', oneLiner: null, clusters: [], memberCount: 0, citedByTotal: 0, updated: null },
      { slug: 'b', title: 'b', oneLiner: null, clusters: ['ai-ml'], memberCount: 4, citedByTotal: 0, updated: null },
    ]);
    expect(reg?.clusters).toEqual({ 'ai-ml': { topicCount: 2 } });
  });

  it('returns null for non-JSON and for a document without a topics array', () => {
    expect(parseRegistryJson('nope')).toBeNull();
    expect(parseRegistryJson('{"topics": "not-an-array"}')).toBeNull();
  });

  it('drops malformed topic entries rather than the whole file', () => {
    const reg = parseRegistryJson('{"topics": [{"slug": "ok"}, {"noslug": 1}, null]}');
    expect(reg?.topics.map((t) => t.slug)).toEqual(['ok']);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';

import { ArticleStore, type ArticleRow } from '../src/shared/article-store.js';
import type { ArticlePlanResult, LibrarianCtx, PlannedArticle } from '../src/shared/librarian-types.js';
import { applyArticlePlans } from '../src/phases/librarian-apply.js';
import { formatTopicPage, stableIdForUrl, stableIdToFilename } from '../src/phases/page-templates.js';
import { VaultFs } from '../src/tools/vault.js';

let dir: string;
let vault: VaultFs;
let store: ArticleStore;

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function ctxWith(plans: ArticlePlanResult[]): LibrarianCtx {
  return {
    cache: new PipelineCache(),
    batchSize: 10,
    signal: new AbortController().signal,
    articlePlans: plans,
  };
}

function insertArticle(title: string, url: string): ArticleRow {
  const res = store.upsertPending({
    title,
    url,
    source: 'test',
    field: 'AI',
    snippet: 'snippet',
    collectedFrom: 'test',
    collectedAt: new Date('2026-05-30T00:00:00Z'),
  });
  expect(res.id).toBeTypeOf('number');
  store.markProcessing(res.id!);
  const row = store.getById(res.id!);
  expect(row).not.toBeNull();
  return row!;
}

function planned(row: ArticleRow, summary = 'Summary text.'): PlannedArticle {
  const stableId = stableIdForUrl(row.url)!;
  const sourceFilename = stableIdToFilename(stableId);
  return {
    article: row,
    stableId,
    sourceFilename,
    sourcePath: `wiki/sources/${sourceFilename}.md`,
    summary,
    reviewer: {
      topics: [{ slug: 'llm-evaluation', why: 'directly relevant' }],
      cites: [],
      related: [],
      entities: [],
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-apply-'));
  vault = new VaultFs(dir);
  mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
  mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
  mkdirSync(join(dir, 'wiki/entities'), { recursive: true });
  store = new ArticleStore(join(dir, 'test.db'));

  await vault.write(
    'wiki/topics/llm-evaluation.md',
    formatTopicPage({
      slug: 'llm-evaluation',
      created: new Date('2026-01-01T00:00:00Z'),
      updated: new Date('2026-01-01T00:00:00Z'),
      definition: 'Evaluation methods for large language models.',
      members: [],
      relatedTopics: [],
    }),
  );
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('applyArticlePlans', () => {
  it('applies multiple plans for the same topic serially without losing members', async () => {
    const a = insertArticle('A paper', 'https://arxiv.org/abs/2605.00001');
    const b = insertArticle('B paper', 'https://arxiv.org/abs/2605.00002');

    const ctx = ctxWith([
      { articleId: a.id, outcome: 'planned', plan: planned(a) },
      { articleId: b.id, outcome: 'planned', plan: planned(b) },
    ]);
    const events = await drain(applyArticlePlans(vault, store).run(ctx));

    expect(ctx.results?.map((r) => r.outcome)).toEqual(['done', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'phase', phase: 'apply-article-plans' });

    const topic = await vault.read('wiki/topics/llm-evaluation.md');
    expect(topic).toContain('[[wiki/sources/arxiv-2605-00001]]');
    expect(topic).toContain('[[wiki/sources/arxiv-2605-00002]]');
    expect(store.getById(a.id)?.status).toBe('done');
    expect(store.getById(b.id)?.status).toBe('done');
  });

  it('rolls back a failed article apply without removing an earlier successful article', async () => {
    const a = insertArticle('Good paper', 'https://arxiv.org/abs/2605.00003');
    const b = insertArticle('Bad paper', 'https://arxiv.org/abs/2605.00004');
    const badPlan = planned(b);
    badPlan.sourcePath = '../escape.md';

    const ctx = ctxWith([
      { articleId: a.id, outcome: 'planned', plan: planned(a) },
      { articleId: b.id, outcome: 'planned', plan: badPlan },
    ]);
    await drain(applyArticlePlans(vault, store).run(ctx));

    expect(ctx.results?.map((r) => r.outcome)).toEqual(['done', 'failed']);
    const topic = await vault.read('wiki/topics/llm-evaluation.md');
    expect(topic).toContain('[[wiki/sources/arxiv-2605-00003]]');
    expect(topic).not.toContain('[[wiki/sources/arxiv-2605-00004]]');
    expect(store.getById(a.id)?.status).toBe('done');
    expect(store.getById(b.id)?.status).toBe('failed');
  });

  it('dry-run previews writes without touching vault files or article status', async () => {
    const a = insertArticle('Preview paper', 'https://arxiv.org/abs/2605.00006');
    const topicBefore = await vault.read('wiki/topics/llm-evaluation.md');
    const plan = planned(a);
    const ctx = ctxWith([{ articleId: a.id, outcome: 'planned', plan }]);

    const events = await drain(applyArticlePlans(vault, store, { dryRun: true }).run(ctx));

    expect(ctx.dryRunPreviews?.[0]).toMatchObject({
      articleId: a.id,
      outcome: 'would-write',
      sourcePagePath: plan.sourcePath,
      topicPagePaths: ['wiki/topics/llm-evaluation.md'],
    });
    expect(ctx.results?.[0]).toMatchObject({ outcome: 'done', reason: 'dry-run' });
    expect(events.at(-1)).toMatchObject({ type: 'phase', phase: 'preview-article-plans' });
    expect(await vault.exists(plan.sourcePath)).toBe(false);
    expect(await vault.read('wiki/topics/llm-evaluation.md')).toBe(topicBefore);
    expect(store.getById(a.id)?.status).toBe('processing');
  });

  it('dry-run validates escaped source paths as would-fail', async () => {
    const a = insertArticle('Invalid preview paper', 'https://arxiv.org/abs/2605.00007');
    const badPlan = planned(a);
    badPlan.sourcePath = '../../../escape.md';
    const ctx = ctxWith([{ articleId: a.id, outcome: 'planned', plan: badPlan }]);

    await drain(applyArticlePlans(vault, store, { dryRun: true }).run(ctx));

    expect(ctx.dryRunPreviews?.[0]).toMatchObject({
      articleId: a.id,
      outcome: 'would-fail',
    });
    expect(ctx.dryRunPreviews?.[0]?.reason).toContain('escapes root');
    expect(store.getById(a.id)?.status).toBe('processing');
  });

  it('dry-run previews already-ingested recovery without changing status', async () => {
    const a = insertArticle('Preview recovered paper', 'https://arxiv.org/abs/2605.00008');
    const plan = planned(a);
    await vault.write(plan.sourcePath, `---\ntype: source\nurl: ${a.url}\n---\n\n# ${a.title}\n`);
    const ctx = ctxWith([{ articleId: a.id, outcome: 'skipped', reason: 'already-ingested', sourcePath: plan.sourcePath }]);

    await drain(applyArticlePlans(vault, store, { dryRun: true }).run(ctx));

    expect(ctx.dryRunPreviews?.[0]).toMatchObject({
      articleId: a.id,
      outcome: 'would-skip',
      reason: 'existing-source-recovered',
      sourcePagePath: plan.sourcePath,
    });
    expect(store.getById(a.id)?.status).toBe('processing');
  });

  it('recovers a matching existing source page as done instead of skipping', async () => {
    const a = insertArticle('Recovered paper', 'https://arxiv.org/abs/2605.00005');
    const plan = planned(a);
    await vault.write(plan.sourcePath, `---\ntype: source\nurl: ${a.url}\n---\n\n# ${a.title}\n`);

    const ctx = ctxWith([{ articleId: a.id, outcome: 'skipped', reason: 'already-ingested', sourcePath: plan.sourcePath }]);
    await drain(applyArticlePlans(vault, store).run(ctx));

    expect(ctx.results?.[0]).toMatchObject({ outcome: 'done', reason: 'existing-source-recovered' });
    expect(store.getById(a.id)?.status).toBe('done');
    expect(store.getById(a.id)?.pagePaths).toEqual([plan.sourcePath]);
  });
});

describe('applyArticlePlans external references + citation demand (tiers 1-2)', () => {
  function routedArticle(refsArxiv: string[]): ArticleRow {
    const res = store.upsertRouted({
      title: 'Citing paper',
      url: 'https://arxiv.org/abs/2607.00100',
      source: 'arXiv',
      field: 'AI/ML',
      summary: '## Overview\nCites things.',
      refsArxiv,
      refsDoi: ['10.9999/unresolved-doi'],
      sharedStableId: 'arxiv-2607-00100',
      routedSimilarity: 0.7,
    });
    store.markProcessing(res.id!);
    return store.getById(res.id!)!;
  }

  it('renders unresolved refs, records demand, and excludes in-library + self refs', async () => {
    // '2605.00001' will be IN the library (ingested first); '1607.08221' will not.
    const resolved = insertArticle('Resolvable cite', 'https://arxiv.org/abs/2605.00001');
    const ctxA = ctxWith([{ articleId: resolved.id, outcome: 'planned', plan: planned(resolved) }]);
    await drain(applyArticlePlans(vault, store).run(ctxA));

    // Citing article refs: one resolvable, one external, plus its own id (self-guard).
    const citing = routedArticle(['2605.00001', '1607.08221', '2607.00100']);
    const recorded: Array<{ refKind: string; refId: string; citingStableId: string }> = [];
    const ctxB = ctxWith([{ articleId: citing.id, outcome: 'planned', plan: planned(citing) }]);
    await drain(
      applyArticlePlans(vault, store, { demandRecorder: (e) => recorded.push(...e) }).run(ctxB),
    );

    const page = await vault.read('wiki/sources/arxiv-2607-00100.md');
    expect(page).toContain('## External references');
    expect(page).toContain('- [arXiv:1607.08221](https://arxiv.org/abs/1607.08221) — not yet in library');
    expect(page).toContain('- [doi:10.9999/unresolved-doi](https://doi.org/10.9999/unresolved-doi) — not yet in library');
    // In-library and self refs must NOT appear as external.
    expect(page).not.toContain('arXiv:2605.00001](');
    expect(page).not.toContain('arXiv:2607.00100](');

    expect(recorded.map((r) => r.refId).sort()).toEqual(['10.9999/unresolved-doi', '1607.08221']);
    expect(recorded.every((r) => r.citingStableId === 'arxiv-2607-00100')).toBe(true);
  });

  it('dry-run never invokes the demand recorder', async () => {
    const citing = routedArticle(['1607.08221']);
    let called = false;
    const ctx = ctxWith([{ articleId: citing.id, outcome: 'planned', plan: planned(citing) }]);
    await drain(
      applyArticlePlans(vault, store, {
        dryRun: true,
        demandRecorder: () => { called = true; },
      }).run(ctx),
    );
    expect(called).toBe(false);
  });

  it('a recorder failure does not fail the article', async () => {
    const citing = routedArticle(['1607.08221']);
    const ctx = ctxWith([{ articleId: citing.id, outcome: 'planned', plan: planned(citing) }]);
    await drain(
      applyArticlePlans(vault, store, {
        demandRecorder: () => { throw new Error('ledger unavailable'); },
      }).run(ctx),
    );
    expect(ctx.results?.[0]?.outcome).toBe('done');
    expect(store.getById(citing.id)?.status).toBe('done');
  });
});

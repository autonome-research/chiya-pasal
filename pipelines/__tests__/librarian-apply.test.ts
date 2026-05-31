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
    body: row.snippet ?? '',
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

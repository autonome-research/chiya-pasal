import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  demandFileName,
  formatDemandSummary,
  parseArgs,
  renderDemandArticles,
  runDemandIngest,
  type DemandRefResolver,
} from '../src/demand-ingest.js';
import { parseArticles } from '../src/shared/article.js';
import { SharedArticleStore } from '../src/shared/shared-article-store.js';
import type { DemandRef, DemandResolution, RefMetadata } from '../src/shared/demand-resolver.js';

const NOW = new Date('2026-08-02T05:10:00Z');

let dir: string;
let inboxDir: string;
let store: SharedArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-demand-'));
  inboxDir = join(dir, 'inbox');
  store = new SharedArticleStore(join(dir, 'articles.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Record N distinct citers for one ref (one user unless handles given). */
function demand(
  refKind: 'arxiv' | 'doi',
  refId: string,
  citers: number,
  userHandle = 'alice',
): void {
  store.recordCitationDemand(
    Array.from({ length: citers }, (_, i) => ({
      userHandle,
      refKind,
      refId,
      citingStableId: `arxiv-2606-${String(i + 1).padStart(5, '0')}`,
    })),
  );
}

function seedArticle(stableId: string, url: string): void {
  store.upsertCollected({
    stableId,
    url,
    title: 'Already in the library',
    source: 'arXiv',
    field: 'AI/ML',
    queryLabels: ['AI/ML'],
    abstract: null,
  });
}

/** Resolver that returns synthetic metadata for every ref it is given. */
function fakeResolver(
  overrides: Partial<Record<string, Partial<RefMetadata> | 'fail'>> = {},
): { resolve: DemandRefResolver; seen: DemandRef[][] } {
  const seen: DemandRef[][] = [];
  const resolve: DemandRefResolver = async (refs) => {
    seen.push(refs);
    const out: DemandResolution = { resolved: [], failures: [] };
    for (const ref of refs) {
      const override = overrides[`${ref.refKind}:${ref.refId}`];
      if (override === 'fail') {
        out.failures.push({
          refKind: ref.refKind,
          refId: ref.refId,
          reason: 'http 500',
          retryable: true,
        });
        continue;
      }
      out.resolved.push({
        refKind: ref.refKind,
        refId: ref.refId,
        url:
          ref.refKind === 'arxiv'
            ? `https://arxiv.org/abs/${ref.refId}`
            : `https://doi.org/${ref.refId}`,
        title: `Paper ${ref.refId}`,
        abstract: `Abstract for ${ref.refId}.`,
        metadataSource: ref.refKind === 'arxiv' ? 'arXiv' : 'Crossref',
        ...override,
      });
    }
    return out;
  };
  return { resolve, seen };
}

function run(
  options: Parameters<typeof runDemandIngest>[0]['options'],
  resolver = fakeResolver(),
): ReturnType<typeof runDemandIngest> {
  return runDemandIngest({ store, inboxDir, resolve: resolver.resolve, options, now: NOW, log: () => {} });
}

describe('parseArgs', () => {
  it('defaults to execute mode with min-citers=3 and limit=25', () => {
    expect(parseArgs([])).toEqual({ minCiters: 3, limit: 25, dryRun: false });
  });

  it('parses every supported flag', () => {
    expect(parseArgs(['--min-citers=5', '--limit=2', '--user=bob', '--dry-run'])).toEqual({
      minCiters: 5,
      limit: 2,
      dryRun: true,
      userHandle: 'bob',
    });
  });

  it('rejects unknown arguments loudly', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown demand-ingest argument/);
  });
});

describe('satisfaction (computed, never stored)', () => {
  it('skips refs whose stable id is already in the library', async () => {
    demand('arxiv', '2107.03374', 4);
    demand('arxiv', '2110.14168', 3);
    seedArticle('arxiv-2107-03374', 'https://arxiv.org/abs/2107.03374');

    const summary = await run({});
    expect(summary.eligible).toBe(2);
    expect(summary.satisfiedSkipped).toBe(1);
    expect(summary.order).toEqual(['arxiv:2110.14168']);
  });

  it('treats a versioned ledger ref as satisfied by the unversioned page', async () => {
    demand('arxiv', '2301.03728v2', 3);
    seedArticle('arxiv-2301-03728', 'https://arxiv.org/abs/2301.03728');

    const summary = await run({});
    expect(summary.satisfiedSkipped).toBe(1);
    expect(summary.considered).toBe(0);
    expect(summary.emitted).toBe(0);
    expect(summary.outPath).toBeNull();
  });

  it('merges versioned and unversioned demand for the same stable id', async () => {
    store.recordCitationDemand([
      { userHandle: 'alice', refKind: 'arxiv', refId: '2301.03728', citingStableId: 'arxiv-a' },
      { userHandle: 'alice', refKind: 'arxiv', refId: '2301.03728', citingStableId: 'arxiv-b' },
      { userHandle: 'bob', refKind: 'arxiv', refId: '2301.03728v2', citingStableId: 'arxiv-c' },
    ]);

    // Neither spelling reaches 3 distinct citers alone; the paper does.
    expect(store.citationDemandTotals({ minCiters: 3 })).toEqual([]);

    const summary = await run({});
    expect(summary.eligible).toBe(1);
    expect(summary.order).toEqual(['arxiv:2301.03728']);
    // One paper → exactly one emitted article, not one per ref spelling.
    expect(parseArticles(readFileSync(summary.outPath!, 'utf8')).map((a) => a.url)).toEqual([
      'https://arxiv.org/abs/2301.03728',
    ]);
  });

  it('merges citers and user handles across ref spellings', () => {
    store.recordCitationDemand([
      { userHandle: 'alice', refKind: 'arxiv', refId: '2301.03728', citingStableId: 'arxiv-a' },
      { userHandle: 'alice', refKind: 'arxiv', refId: '2301.03728', citingStableId: 'arxiv-b' },
      { userHandle: 'bob', refKind: 'arxiv', refId: '2301.03728v2', citingStableId: 'arxiv-c' },
    ]);
    const merged = store.unsatisfiedCitationDemand({
      stableIdFor: (kind, id) =>
        kind === 'arxiv' ? `arxiv-${id.replace(/v\d+$/, '').replace(/\./g, '-')}` : null,
      minCiters: 3,
    });
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]).toMatchObject({
      stableId: 'arxiv-2301-03728',
      demandCount: 3,
      citers: ['arxiv-a', 'arxiv-b', 'arxiv-c'],
      userHandles: ['alice', 'bob'],
    });
  });

  it('skips satisfied dois through the same stable-id path', async () => {
    demand('doi', '10.1145/3580305', 3);
    demand('doi', '10.1038/s41586-020-2649-2', 3);
    seedArticle('doi-10-1145-3580305', 'https://doi.org/10.1145/3580305');

    const summary = await run({});
    expect(summary.satisfiedSkipped).toBe(1);
    expect(summary.order).toEqual(['doi:10.1038/s41586-020-2649-2']);
  });

  it('counts unmappable ledger refs instead of emitting garbage', async () => {
    demand('arxiv', 'not-an-id', 5);
    demand('arxiv', '2110.14168', 3);

    const summary = await run({});
    expect(summary.unmapped).toBe(1);
    expect(summary.order).toEqual(['arxiv:2110.14168']);
  });
});

describe('K filtering and capping', () => {
  it('ignores refs below the citer threshold', async () => {
    demand('arxiv', '2107.03374', 3);
    demand('arxiv', '2110.14168', 2);

    expect((await run({})).order).toEqual(['arxiv:2107.03374']);
    expect((await run({ minCiters: 2 })).order).toEqual([
      'arxiv:2107.03374',
      'arxiv:2110.14168',
    ]);
    expect((await run({ minCiters: 4 })).order).toEqual([]);
  });

  it('counts DISTINCT citing articles, not ledger rows', async () => {
    // The same source page copied into two vaults is ONE citer.
    store.recordCitationDemand([
      { userHandle: 'alice', refKind: 'arxiv', refId: '2110.14168', citingStableId: 'arxiv-1' },
      { userHandle: 'bob', refKind: 'arxiv', refId: '2110.14168', citingStableId: 'arxiv-1' },
      { userHandle: 'bob', refKind: 'arxiv', refId: '2110.14168', citingStableId: 'arxiv-2' },
    ]);
    expect((await run({ minCiters: 3 })).order).toEqual([]);
    expect((await run({ minCiters: 2 })).order).toEqual(['arxiv:2110.14168']);
  });

  it('scopes demand to one user when --user is given', async () => {
    demand('arxiv', '2107.03374', 3, 'alice');
    demand('arxiv', '2110.14168', 3, 'bob');

    expect((await run({ userHandle: 'alice' })).order).toEqual(['arxiv:2107.03374']);
    expect((await run({ userHandle: 'bob' })).order).toEqual(['arxiv:2110.14168']);
  });

  it('caps the run and keeps the most-demanded refs first', async () => {
    demand('arxiv', '2505.09388', 13);
    demand('arxiv', '2107.03374', 10);
    demand('arxiv', '2110.14168', 8);

    const summary = await run({ limit: 2 });
    expect(summary.eligible).toBe(3);
    expect(summary.order).toEqual(['arxiv:2505.09388', 'arxiv:2107.03374']);
    expect(summary.emitted).toBe(2);

    const parsed = parseArticles(readFileSync(summary.outPath!, 'utf8'));
    expect(parsed.map((a) => a.url)).toEqual([
      'https://arxiv.org/abs/2505.09388',
      'https://arxiv.org/abs/2107.03374',
    ]);
  });

  it('applies the cap AFTER satisfaction filtering so it is never starved', async () => {
    demand('arxiv', '2505.09388', 13);
    demand('arxiv', '2107.03374', 10);
    demand('arxiv', '2110.14168', 8);
    seedArticle('arxiv-2505-09388', 'https://arxiv.org/abs/2505.09388');

    const summary = await run({ limit: 1 });
    expect(summary.order).toEqual(['arxiv:2107.03374']);
  });
});

describe('emitted inbox file', () => {
  it('round-trips through parseArticles with the demand source label', async () => {
    demand('arxiv', '2107.03374', 4);
    demand('doi', '10.1145/3580305', 3);

    const summary = await run({});
    expect(summary.outPath).toBe(join(inboxDir, '2026-08-02-demand-articles.md'));
    expect(summary.emitted).toBe(2);

    const parsed = parseArticles(readFileSync(summary.outPath!, 'utf8'));
    expect(parsed).toEqual([
      {
        title: 'Paper 2107.03374',
        url: 'https://arxiv.org/abs/2107.03374',
        source: 'demand',
        field: 'Demand',
        snippet: 'Abstract for 2107.03374.',
      },
      {
        title: 'Paper 10.1145/3580305',
        url: 'https://doi.org/10.1145/3580305',
        source: 'demand',
        field: 'Demand',
        snippet: 'Abstract for 10.1145/3580305.',
      },
    ]);
  });

  it('lands on the *-articles.md name the shared inbox scan globs', () => {
    expect(demandFileName(NOW)).toBe('2026-08-02-demand-articles.md');
    expect(demandFileName(NOW).endsWith('-articles.md')).toBe(true);
  });

  it('keeps the demand evidence as comments the parser ignores', async () => {
    demand('arxiv', '2505.09388', 13);
    const summary = await run({});
    const text = readFileSync(summary.outPath!, 'utf8');
    expect(text).toContain('<!-- arxiv:2505.09388 citers=13 via=arXiv -->');
    expect(parseArticles(text)).toHaveLength(1);
  });

  it('renders an article without an abstract as a snippet-free line', () => {
    const md = renderDemandArticles(
      [
        {
          metadata: {
            refKind: 'arxiv',
            refId: '1412.6980',
            url: 'https://arxiv.org/abs/1412.6980',
            title: 'Adam: A Method for [Stochastic] Optimization',
            abstract: null,
            metadataSource: 'arXiv',
          },
          demandCount: 5,
        },
      ],
      NOW,
    );
    const parsed = parseArticles(md);
    expect(parsed).toHaveLength(1);
    // Brackets in the title would break the line regex, so they are repaired.
    expect(parsed[0]!.title).toBe('Adam: A Method for (Stochastic) Optimization');
    expect(parsed[0]!.snippet).toBeNull();
  });

  it('writes nothing when there is no unsatisfied demand', async () => {
    const summary = await run({});
    expect(summary).toMatchObject({ eligible: 0, considered: 0, emitted: 0, outPath: null });
    expect(existsSync(inboxDir)).toBe(false);
  });
});

describe('resolution failures', () => {
  it('emits the refs that resolved and counts the ones that did not', async () => {
    demand('arxiv', '2505.09388', 13);
    demand('arxiv', '2107.03374', 10);

    const summary = await run({}, fakeResolver({ 'arxiv:2107.03374': 'fail' }));
    expect(summary).toMatchObject({ considered: 2, resolved: 1, emitted: 1, failed: 1 });
    expect(summary.failures).toEqual(['arxiv:2107.03374 — http 500 (retryable)']);
    expect(parseArticles(readFileSync(summary.outPath!, 'utf8'))).toHaveLength(1);
  });

  it('drops a resolved ref whose url cannot be rendered in the line format', async () => {
    demand('doi', '10.1145/a(b)c', 3);

    const summary = await run(
      {},
      fakeResolver({ 'doi:10.1145/a(b)c': { url: 'https://doi.org/10.1145/a(b)c' } }),
    );
    expect(summary).toMatchObject({ resolved: 1, emitted: 0, failed: 1, outPath: null });
    expect(summary.failures[0]).toContain('unrenderable title/url');
  });

  it('writes no file at all when every ref fails to resolve', async () => {
    demand('arxiv', '2505.09388', 13);
    const summary = await run({}, fakeResolver({ 'arxiv:2505.09388': 'fail' }));
    expect(summary).toMatchObject({ emitted: 0, failed: 1, outPath: null });
    expect(readdirSync(dir)).not.toContain('inbox');
  });
});

describe('dry-run', () => {
  it('prints the would-emit list without resolving or writing', async () => {
    demand('arxiv', '2505.09388', 13);
    const resolver = fakeResolver();
    const lines: string[] = [];

    const summary = await runDemandIngest({
      store,
      inboxDir,
      resolve: resolver.resolve,
      options: { dryRun: true },
      now: NOW,
      log: (l) => lines.push(l),
    });

    expect(resolver.seen).toEqual([]);
    expect(existsSync(inboxDir)).toBe(false);
    expect(summary).toMatchObject({ considered: 1, emitted: 0, dryRun: true, outPath: null });
    expect(lines).toEqual([
      '[demand] would emit arxiv:2505.09388 citers=13 → arxiv-2505-09388',
    ]);
  });
});

describe('formatDemandSummary', () => {
  it('reports every per-run counter', () => {
    const line = formatDemandSummary({
      eligible: 43,
      satisfiedSkipped: 12,
      unmapped: 1,
      considered: 25,
      resolved: 24,
      emitted: 24,
      failed: 1,
      failures: ['doi:10.1/x — http 500 (retryable)'],
      outPath: '/inbox/2026-08-02-demand-articles.md',
      dryRun: false,
      order: [],
    });
    expect(line).toContain(
      'eligible=43 satisfied-skipped=12 unmapped=1 considered=25 resolved=24 emitted=24 failed=1',
    );
    expect(line).toContain('wrote /inbox/2026-08-02-demand-articles.md');
    expect(line).toContain('failures: doi:10.1/x — http 500 (retryable)');
  });
});

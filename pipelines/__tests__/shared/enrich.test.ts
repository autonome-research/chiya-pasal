import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';

import {
  articleDoi,
  candidateUrls,
  enrichOne,
  enrichPending,
  ACCEPT_MIN_CHARS,
  GOOD_ENOUGH_CHARS,
} from '../../src/phases/shared/enrich.js';
import { SharedArticleStore, type SharedArticleRow } from '../../src/shared/shared-article-store.js';
import type { SharedPipelineCtx } from '../../src/shared/shared-pipeline-types.js';
import type { FetchDocumentResult } from '../../src/shared/fulltext.js';
import type { UnpaywallResult } from '../../src/shared/unpaywall.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function row(over: Partial<SharedArticleRow>): SharedArticleRow {
  return {
    stableId: 'arxiv-2606-11111',
    url: 'https://arxiv.org/abs/2606.11111',
    urlHash: 'x',
    title: 'T',
    source: 'arXiv',
    field: 'AI/ML',
    queryLabels: ['AI/ML'],
    abstract: 'An abstract.',
    fulltext: null,
    summary: null,
    summaryEmbedding: null,
    refsArxiv: [],
    refsDoi: [],
    collectedAt: new Date(),
    enrichedAt: null,
    summarizedAt: null,
    routedAt: null,
    status: 'pending',
    statusReason: null,
    ...over,
  };
}

const LONG = (n: number): string => 'Full text with arXiv:1607.08221 inside. '.repeat(Math.ceil(n / 40)).slice(0, n);

describe('candidateUrls', () => {
  it('prepends the arXiv native-HTML rung for arXiv articles', () => {
    const c = candidateUrls('https://arxiv.org/abs/2606.11111');
    expect(c).toEqual([
      { url: 'https://arxiv.org/html/2606.11111', via: 'arxiv-html' },
      { url: 'https://arxiv.org/abs/2606.11111', via: 'direct' },
    ]);
  });

  it('non-arXiv URLs get only the direct rung', () => {
    expect(candidateUrls('https://www.nature.com/articles/x')).toEqual([
      { url: 'https://www.nature.com/articles/x', via: 'direct' },
    ]);
  });
});

describe('articleDoi', () => {
  it('extracts the DOI from doi.org URLs', () => {
    expect(articleDoi('https://doi.org/10.1038/s41586-020-2649-2')).toBe('10.1038/s41586-020-2649-2');
  });
  it('returns null for non-DOI URLs', () => {
    expect(articleDoi('https://arxiv.org/abs/2606.11111')).toBeNull();
  });
});

describe('enrichOne ladder', () => {
  it('accepts arXiv HTML full text and stops there when good enough', async () => {
    const calls: string[] = [];
    const outcome = await enrichOne(row({}), {
      unpaywallEmail: 'c@x.com',
      fetchDoc: async (url) => {
        calls.push(url);
        return { ok: true, text: LONG(GOOD_ENOUGH_CHARS + 100), kind: 'html' };
      },
      resolveOaFn: async () => {
        throw new Error('should not reach unpaywall');
      },
    });
    expect(outcome.outcome).toBe('enriched');
    expect(outcome.via).toBe('arxiv-html');
    expect(outcome.refsArxiv).toContain('1607.08221');
    expect(calls).toEqual(['https://arxiv.org/html/2606.11111']);
  });

  it('falls through to the direct URL when arXiv HTML 404s', async () => {
    const outcome = await enrichOne(row({}), {
      unpaywallEmail: null,
      fetchDoc: async (url) =>
        url.includes('/html/')
          ? { ok: false, reason: 'http 404', retryable: false }
          : { ok: true, text: LONG(ACCEPT_MIN_CHARS + 50), kind: 'html' },
    });
    expect(outcome.outcome).toBe('enriched');
    expect(outcome.via).toBe('direct');
  });

  it('tries the Unpaywall rung for DOI articles with thin direct text', async () => {
    const oaCalls: string[] = [];
    const outcome = await enrichOne(
      row({ stableId: 'doi-10-1038-x', url: 'https://doi.org/10.1038/x' }),
      {
        unpaywallEmail: 'c@x.com',
        fetchDoc: async (url) =>
          url.includes('oa-copy')
            ? { ok: true, text: LONG(GOOD_ENOUGH_CHARS), kind: 'pdf' }
            : { ok: false, reason: 'http 403', retryable: false },
        resolveOaFn: async (doi): Promise<UnpaywallResult> => {
          oaCalls.push(doi);
          return {
            status: 'oa',
            location: {
              url: 'https://repo.example/oa-copy.pdf',
              pdfUrl: 'https://repo.example/oa-copy.pdf',
              landingUrl: null,
              hostType: 'repository',
              version: 'acceptedVersion',
              license: 'cc-by',
            },
          };
        },
      },
    );
    expect(outcome.outcome).toBe('enriched');
    expect(outcome.via).toBe('unpaywall');
    expect(oaCalls).toEqual(['10.1038/x']);
  });

  it('skips the Unpaywall rung when no email is configured', async () => {
    const outcome = await enrichOne(
      row({ url: 'https://doi.org/10.1038/x' }),
      {
        unpaywallEmail: null,
        fetchDoc: async () => ({ ok: false, reason: 'http 403', retryable: false }),
        resolveOaFn: async () => {
          throw new Error('should not be called');
        },
      },
    );
    expect(outcome.outcome).toBe('enrich-failed');
  });

  it('returns retry-later when all failures are retryable', async () => {
    const outcome = await enrichOne(row({}), {
      unpaywallEmail: null,
      fetchDoc: async () => ({ ok: false, reason: 'http 503', retryable: true }),
    });
    expect(outcome.outcome).toBe('retry-later');
  });

  it('returns enrich-failed when any failure is non-retryable and no text found', async () => {
    const outcome = await enrichOne(row({}), {
      unpaywallEmail: null,
      fetchDoc: async (url) =>
        url.includes('/html/')
          ? { ok: false, reason: 'http 404', retryable: false }
          : ({ ok: false, reason: 'http 503', retryable: true } satisfies FetchDocumentResult),
    });
    expect(outcome.outcome).toBe('enrich-failed');
  });

  it('rejects text below ACCEPT_MIN_CHARS as enrich-failed', async () => {
    const outcome = await enrichOne(row({}), {
      unpaywallEmail: null,
      fetchDoc: async () => ({ ok: true, text: 'too short', kind: 'html' }),
    });
    expect(outcome.outcome).toBe('enrich-failed');
    expect(outcome.reason).toContain('too short');
  });
});

describe('enrichPending phase', () => {
  let dir: string;
  let store: SharedArticleStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chiya-enrich-'));
    store = new SharedArticleStore(join(dir, 'articles.db'));
    store.upsertCollected({
      stableId: 'arxiv-2606-11111',
      url: 'https://arxiv.org/abs/2606.11111',
      title: 'Good article',
      source: 'arXiv',
      field: 'AI/ML',
      queryLabels: ['AI/ML'],
      abstract: 'abs',
    });
    store.upsertCollected({
      stableId: 'url-deadbeef0000',
      url: 'https://example.com/broken',
      title: 'Broken article',
      source: null,
      field: null,
      queryLabels: [],
      abstract: 'abs2',
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('transitions rows per outcome and leaves retryables pending', async () => {
    const ctx: SharedPipelineCtx = { cache: new PipelineCache(), signal: new AbortController().signal };
    await drain(
      enrichPending(store, {
        unpaywallEmail: null,
        fetchDoc: async (url) =>
          url.includes('arxiv')
            ? { ok: true, text: LONG(GOOD_ENOUGH_CHARS), kind: 'html' }
            : { ok: false, reason: 'http 503', retryable: true },
      }).run(ctx),
    );

    expect(ctx.enrichCounts).toEqual({ enriched: 1, enrichFailed: 0, retryLater: 1 });
    expect(store.findByStableId('arxiv-2606-11111')!.status).toBe('enriched');
    expect(store.findByStableId('url-deadbeef0000')!.status).toBe('pending'); // retries next cycle
  });
});

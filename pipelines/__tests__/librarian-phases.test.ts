import { describe, it, expect } from 'vitest';

import {
  batchEnrich,
  batchExtractRefs,
  htmlToText,
  loadBatch,
  shouldFetch,
} from '../src/phases/librarian-phases.js';
import type {
  EnrichedArticle,
  ExtractedRefs,
  LibrarianCtx,
} from '../src/shared/librarian-types.js';
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
});

describe('htmlToText', () => {
  it('strips <script> blocks (with content)', () => {
    const out = htmlToText('a<script>var x = 1; alert("hi");</script>b');
    expect(out).not.toMatch(/alert/);
    expect(out).not.toMatch(/var x/);
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('strips <style> blocks (with content)', () => {
    const out = htmlToText('a<style>.foo{color:red}</style>b');
    expect(out).not.toMatch(/color:red/);
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('paragraphs become newlines', () => {
    expect(htmlToText('<p>One</p><p>Two</p>').trim()).toBe('One\nTwo');
  });

  it('<br> and <br/> produce newlines', () => {
    expect(htmlToText('A<br>B<br/>C').trim()).toBe('A\nB\nC');
  });

  it('decodes the supported entities', () => {
    expect(htmlToText('&amp;')).toBe('&');
    expect(htmlToText('&lt;')).toBe('<');
    expect(htmlToText('&gt;')).toBe('>');
    expect(htmlToText('&quot;')).toBe('"');
    expect(htmlToText('&#39;')).toBe("'");
    // &nbsp; decodes to a space, then whitespace gets trimmed at the edges.
    expect(htmlToText('a&nbsp;b')).toBe('a b');
  });

  it('caps output at 50000 chars', () => {
    const big = 'x'.repeat(60_000);
    expect(htmlToText(big).length).toBe(50_000);
  });

  it('empty input → empty string', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('shouldFetch', () => {
  it('snippet >= 200 chars → false', () => {
    expect(shouldFetch({ snippet: 'a'.repeat(200), url: 'https://example.com' })).toBe(false);
    expect(shouldFetch({ snippet: 'a'.repeat(500), url: 'https://example.com' })).toBe(false);
  });

  it('snippet null + http URL → true', () => {
    expect(shouldFetch({ snippet: null, url: 'https://example.com' })).toBe(true);
  });

  it('thin snippet + http URL → true', () => {
    expect(shouldFetch({ snippet: 'a'.repeat(50), url: 'https://example.com' })).toBe(true);
  });

  it('null URL → false', () => {
    expect(shouldFetch({ snippet: null, url: null })).toBe(false);
    expect(shouldFetch({ snippet: 'short', url: null })).toBe(false);
  });

  it('non-http URL (doi:...) → false', () => {
    expect(shouldFetch({ snippet: 'short', url: 'doi:10.1038/foo' })).toBe(false);
  });

  it('arxiv https URL with thin snippet → true', () => {
    expect(shouldFetch({ snippet: 'short', url: 'https://arxiv.org/abs/2605.03823' })).toBe(true);
  });

  it('http (not https) URL still counts', () => {
    expect(shouldFetch({ snippet: null, url: 'http://example.com' })).toBe(true);
  });
});

describe('batchExtractRefs', () => {
  it('populates ctx.refs with arxiv ids and DOIs from each article body', async () => {
    const enriched: EnrichedArticle[] = [
      {
        articleId: 11,
        body: 'See arXiv:2605.03823 and 10.1038/s41586-020-2649-2 for details.',
        enriched: true,
      },
      {
        articleId: 22,
        body: 'Older paper hep-th/9901001 with DOI 10.1145/3580305.3599350.',
        enriched: true,
      },
    ];
    const ctx = makeCtx({ enriched });
    const events = await drain(batchExtractRefs().run(ctx));

    expect(ctx.refs).toBeDefined();
    const refs = ctx.refs as ExtractedRefs[];
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      articleId: 11,
      arxivIds: ['2605.03823'],
      dois: ['10.1038/s41586-020-2649-2'],
    });
    expect(refs[1]).toEqual({
      articleId: 22,
      arxivIds: ['hep-th/9901001'],
      dois: ['10.1145/3580305.3599350'],
    });

    const phaseEvent = events.find(
      (e): e is Extract<typeof e, { type: 'phase' }> =>
        (e as { type?: string }).type === 'phase',
    );
    expect(phaseEvent).toBeDefined();
    expect(phaseEvent!.phase).toBe('batch-extract-refs');
    expect(phaseEvent!.counts).toEqual({ articles: 2, refs: 4 });
  });

  it('handles bodies with no refs', async () => {
    const enriched: EnrichedArticle[] = [
      { articleId: 1, body: 'plain prose with no identifiers', enriched: false },
    ];
    const ctx = makeCtx({ enriched });
    await drain(batchExtractRefs().run(ctx));
    expect(ctx.refs).toEqual([{ articleId: 1, arxivIds: [], dois: [] }]);
  });
});

describe('batchEnrich (no-fetch shape)', () => {
  it('passes thick snippets straight through without fetching', async () => {
    const fatSnippet = 'x'.repeat(250);
    const batch: ArticleRow[] = [
      mkRow({ id: 1, url: 'https://example.com/a', snippet: fatSnippet }),
      mkRow({ id: 2, url: null, snippet: 'short snippet' }),
      mkRow({ id: 3, url: 'doi:10.1038/foo', snippet: 'short' }),
    ];
    const ctx = makeCtx({ batch });
    const events = await drain(batchEnrich().run(ctx));

    expect(ctx.enriched).toBeDefined();
    const enr = ctx.enriched as EnrichedArticle[];
    expect(enr).toHaveLength(3);
    for (const e of enr) {
      expect(e.enriched).toBe(false);
      expect(e.enrichError).toBeUndefined();
    }
    expect(enr[0]!.body).toBe(fatSnippet);
    expect(enr[1]!.body).toBe('short snippet');
    expect(enr[2]!.body).toBe('short');

    const phase = events.find(
      (e): e is Extract<typeof e, { type: 'phase' }> =>
        (e as { type?: string }).type === 'phase',
    );
    expect(phase).toBeDefined();
    expect(phase!.phase).toBe('batch-enrich');
    expect(phase!.counts).toMatchObject({ articles: 3, fetched: 0, skipped: 3 });
  });

  it('empty batch → empty enriched + zero counts', async () => {
    const ctx = makeCtx({ batch: [] });
    const events = await drain(batchEnrich().run(ctx));
    expect(ctx.enriched).toEqual([]);
    const phase = events.find(
      (e): e is Extract<typeof e, { type: 'phase' }> =>
        (e as { type?: string }).type === 'phase',
    );
    expect(phase!.counts).toMatchObject({ articles: 0, fetched: 0, skipped: 0 });
  });

  it('null snippet treated as empty body', async () => {
    const batch: ArticleRow[] = [mkRow({ id: 7, url: null, snippet: null })];
    const ctx = makeCtx({ batch });
    await drain(batchEnrich().run(ctx));
    const enr = ctx.enriched as EnrichedArticle[];
    expect(enr[0]).toEqual({ articleId: 7, body: '', enriched: false });
  });
});

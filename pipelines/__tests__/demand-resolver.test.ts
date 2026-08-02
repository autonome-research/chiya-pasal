import { describe, it, expect } from 'vitest';

import {
  canonicalRefUrl,
  cleanProse,
  demandRefStableId,
  normalizeArxivId,
  parseArxivFeed,
  resolveArxivBatch,
  resolveCrossrefDoi,
  resolveDemandRefs,
  type DemandResolverOptions,
} from '../src/shared/demand-resolver.js';
import { stableIdForUrl, stableIdToFilename } from '../src/phases/page-templates.js';

interface Call {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(
  handler: (url: string) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    return handler(url);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function xmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { 'content-type': 'application/atom+xml' } });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
}

function feed(entries: Array<{ id: string; title: string; summary?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
${entries
  .map(
    (e) => `  <entry>
    <id>${e.id}</id>
    <title>${e.title}</title>
    <summary>${e.summary ?? ''}</summary>
  </entry>`,
  )
  .join('\n')}
</feed>`;
}

/** Never let a test pause for real. */
const noSleep: DemandResolverOptions['sleep'] = async () => {};

describe('normalizeArxivId', () => {
  it('strips scheme, url wrapper, .pdf, and version suffix', () => {
    expect(normalizeArxivId('2301.03728')).toBe('2301.03728');
    expect(normalizeArxivId('arXiv:2301.03728v2')).toBe('2301.03728');
    expect(normalizeArxivId('https://arxiv.org/abs/2301.03728v11')).toBe('2301.03728');
    expect(normalizeArxivId('http://export.arxiv.org/pdf/2301.03728.pdf')).toBe('2301.03728');
    expect(normalizeArxivId('  cs.AI/0501001v3 ')).toBe('cs.AI/0501001');
  });
});

describe('canonicalRefUrl', () => {
  it('builds abs/doi.org URLs that round-trip through stableIdForUrl', () => {
    const arxivUrl = canonicalRefUrl('arxiv', '2107.03374v1')!;
    expect(arxivUrl).toBe('https://arxiv.org/abs/2107.03374');
    expect(stableIdToFilename(stableIdForUrl(arxivUrl)!)).toBe('arxiv-2107-03374');

    const doiUrl = canonicalRefUrl('doi', 'https://doi.org/10.1145/3580305.3599350')!;
    expect(doiUrl).toBe('https://doi.org/10.1145/3580305.3599350');
    expect(stableIdToFilename(stableIdForUrl(doiUrl)!)).toBe('doi-10-1145-3580305-3599350');
  });

  it('returns null for ids that are not identifiers at all', () => {
    expect(canonicalRefUrl('arxiv', '   ')).toBeNull();
    expect(canonicalRefUrl('doi', 'not-a-doi')).toBeNull();
  });
});

describe('demandRefStableId', () => {
  it('maps an arxiv ref to its source-page stable id', () => {
    expect(demandRefStableId('arxiv', '2301.03728')).toBe('arxiv-2301-03728');
  });

  it('collapses version suffixes onto the same stable id', () => {
    expect(demandRefStableId('arxiv', '2301.03728v2')).toBe('arxiv-2301-03728');
    expect(demandRefStableId('arxiv', 'arXiv:2301.03728v11')).toBe('arxiv-2301-03728');
  });

  it('maps old-style arxiv ids', () => {
    expect(demandRefStableId('arxiv', 'cs.AI/0501001')).toBe('arxiv-cs-ai-0501001');
  });

  it('maps a doi ref through the doi.org stable-id path', () => {
    expect(demandRefStableId('doi', '10.1038/S41586-020-2649-2')).toBe(
      'doi-10-1038-s41586-020-2649-2',
    );
    expect(demandRefStableId('doi', 'doi:10.1145/3580305')).toBe('doi-10-1145-3580305');
  });

  it('returns null rather than a url-hash id when the ref does not parse as its kind', () => {
    expect(demandRefStableId('arxiv', 'totally bogus')).toBeNull();
    expect(demandRefStableId('doi', '99.1234/x')).toBeNull();
  });
});

describe('cleanProse', () => {
  it('collapses wrapped whitespace, strips tags, and decodes entities', () => {
    expect(cleanProse('  We show\n  that A &amp; B\n  hold.  ')).toBe('We show that A & B hold.');
    expect(cleanProse('<jats:p>Deep <jats:italic>nets</jats:italic></jats:p>')).toBe('Deep nets');
    expect(cleanProse('&#x1D6FC; and &#945;')).toBe('𝛼 and α');
  });

  it('truncates with an ellipsis and returns null for empty input', () => {
    expect(cleanProse('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
    expect(cleanProse(null)).toBeNull();
    expect(cleanProse('   ')).toBeNull();
  });

  it('leaves out-of-range numeric references as literal text instead of throwing', () => {
    // String.fromCodePoint throws above 0x10FFFF; a malformed feed entry must
    // degrade, not take down the whole run (contract at demand-resolver.ts:16).
    expect(cleanProse('bad &#x110000; ref')).toBe('bad &#x110000; ref');
    expect(cleanProse('bad &#1114112; ref')).toBe('bad &#1114112; ref');
    expect(cleanProse('ok &#945; and bad &#x7FFFFFFF;')).toBe('ok α and bad &#x7FFFFFFF;');
  });
});

describe('parseArxivFeed', () => {
  it('parses entries into bare-id keyed metadata', () => {
    const parsed = parseArxivFeed(
      feed([
        {
          id: 'http://arxiv.org/abs/2107.03374v2',
          title: 'Evaluating Large Language Models\n  Trained on Code',
          summary: 'We introduce Codex,\n  a GPT language model.',
        },
      ]),
    );
    expect([...parsed.keys()]).toEqual(['2107.03374']);
    expect(parsed.get('2107.03374')).toEqual({
      title: 'Evaluating Large Language Models Trained on Code',
      abstract: 'We introduce Codex, a GPT language model.',
    });
  });

  it('drops arxiv error entries instead of ingesting a paper called Error', () => {
    const parsed = parseArxivFeed(
      feed([
        { id: 'http://arxiv.org/api/errors#incorrect_id_format', title: 'Error' },
        { id: 'http://arxiv.org/abs/1412.6980v9', title: 'Adam' },
      ]),
    );
    expect([...parsed.keys()]).toEqual(['1412.6980']);
  });
});

describe('resolveArxivBatch', () => {
  it('requests all ids in one call with an explicit max_results and a contact UA', async () => {
    const { fetch, calls } = recordingFetch(() =>
      xmlResponse(
        feed([
          { id: 'http://arxiv.org/abs/2107.03374v2', title: 'Codex', summary: 'Code models.' },
          { id: 'http://arxiv.org/abs/1412.6980v9', title: 'Adam', summary: 'An optimizer.' },
        ]),
      ),
    );
    const out = await resolveArxivBatch(['2107.03374', '1412.6980v9'], {
      fetch,
      contactEmail: 'chiya@example.com',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('export.arxiv.org/api/query');
    expect(calls[0]!.url).toContain('id_list=2107.03374%2C1412.6980');
    expect(calls[0]!.url).toContain('max_results=2');
    expect(calls[0]!.headers['user-agent']).toBe('chiya-library/1.0 (mailto:chiya@example.com)');

    const codex = out.get('2107.03374')!;
    expect(codex.status).toBe('ok');
    if (codex.status === 'ok') {
      expect(codex.metadata).toMatchObject({
        refKind: 'arxiv',
        refId: '2107.03374',
        url: 'https://arxiv.org/abs/2107.03374',
        title: 'Codex',
        abstract: 'Code models.',
        metadataSource: 'arXiv',
      });
    }
    // The versioned request id keeps its original form in the result key.
    expect(out.get('1412.6980v9')!.status).toBe('ok');
  });

  it('marks ids missing from the feed as not-found', async () => {
    const { fetch } = recordingFetch(() =>
      xmlResponse(feed([{ id: 'http://arxiv.org/abs/2107.03374v2', title: 'Codex' }])),
    );
    const out = await resolveArxivBatch(['2107.03374', '2110.14168'], { fetch });
    expect(out.get('2110.14168')).toEqual({ status: 'not-found', reason: 'no arxiv entry' });
  });

  it('classifies 5xx as retryable and 4xx as terminal', async () => {
    const down = recordingFetch(() => new Response('', { status: 503 }));
    expect(await resolveArxivBatch(['2107.03374'], { fetch: down.fetch })).toEqual(
      new Map([['2107.03374', { status: 'error', reason: 'http 503', retryable: true }]]),
    );

    const bad = recordingFetch(() => new Response('', { status: 400 }));
    expect(await resolveArxivBatch(['2107.03374'], { fetch: bad.fetch })).toEqual(
      new Map([['2107.03374', { status: 'error', reason: 'http 400', retryable: false }]]),
    );
  });

  it('turns a timeout/network throw into a retryable error without throwing', async () => {
    const { fetch } = recordingFetch(() => {
      throw new Error('The operation was aborted due to timeout');
    });
    const out = await resolveArxivBatch(['2107.03374'], { fetch, timeoutMs: 5 });
    const result = out.get('2107.03374')!;
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.retryable).toBe(true);
      expect(result.reason).toContain('aborted');
    }
  });

  it('never issues a request for an unparseable id', async () => {
    const { fetch, calls } = recordingFetch(() => xmlResponse(feed([])));
    const out = await resolveArxivBatch(['   '], { fetch });
    expect(calls).toHaveLength(0);
    expect(out.get('   ')).toEqual({ status: 'not-found', reason: 'unparseable arxiv id' });
  });
});

describe('resolveCrossrefDoi', () => {
  it('resolves title and JATS abstract, adding mailto for the polite pool', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({
        message: {
          title: ['Attention Is All You Need'],
          abstract: '<jats:p>The dominant sequence transduction models&#8230;</jats:p>',
        },
      }),
    );
    const result = await resolveCrossrefDoi('10.5555/3295222.3295349', {
      fetch,
      contactEmail: 'chiya@example.com',
    });

    expect(calls[0]!.url).toBe(
      'https://api.crossref.org/works/10.5555%2F3295222.3295349?mailto=chiya%40example.com',
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.metadata).toMatchObject({
        refKind: 'doi',
        url: 'https://doi.org/10.5555/3295222.3295349',
        title: 'Attention Is All You Need',
        abstract: 'The dominant sequence transduction models…',
        metadataSource: 'Crossref',
      });
    }
  });

  it('maps 404 to not-found and 429 to a retryable error', async () => {
    const missing = recordingFetch(() => new Response('', { status: 404 }));
    expect(await resolveCrossrefDoi('10.1145/nope', { fetch: missing.fetch })).toEqual({
      status: 'not-found',
      reason: 'doi unknown to crossref',
    });

    const limited = recordingFetch(() => new Response('', { status: 429 }));
    expect(await resolveCrossrefDoi('10.1145/nope', { fetch: limited.fetch })).toEqual({
      status: 'error',
      reason: 'http 429',
      retryable: true,
    });
  });

  it('treats a record without a title as not-found', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ message: { title: [] } }));
    const result = await resolveCrossrefDoi('10.1145/x', { fetch });
    expect(result).toEqual({ status: 'not-found', reason: 'crossref record has no title' });
  });

  it('skips the request entirely for a malformed doi', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    expect(await resolveCrossrefDoi('nonsense', { fetch })).toEqual({
      status: 'not-found',
      reason: 'unparseable doi',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('resolveDemandRefs', () => {
  it('batches arxiv, queries dois individually, and preserves input order', async () => {
    const { fetch, calls } = recordingFetch((url) => {
      if (url.includes('export.arxiv.org')) {
        const ids = decodeURIComponent(/id_list=([^&]+)/.exec(url)![1]!).split(',');
        return xmlResponse(
          feed(ids.map((id) => ({ id: `http://arxiv.org/abs/${id}v1`, title: `paper ${id}` }))),
        );
      }
      return jsonResponse({ message: { title: ['A DOI paper'] } });
    });

    const pauses: number[] = [];
    const out = await resolveDemandRefs(
      [
        { refKind: 'arxiv', refId: '2505.09388' },
        { refKind: 'doi', refId: '10.1145/3580305' },
        { refKind: 'arxiv', refId: '2107.03374' },
        { refKind: 'arxiv', refId: '1412.6980' },
      ],
      {
        fetch,
        batchSize: 2,
        pauseMs: 1000,
        sleep: async (ms) => {
          pauses.push(ms);
        },
      },
    );

    // 2 arxiv batches (2 + 1 ids) + 1 crossref call.
    expect(calls).toHaveLength(3);
    // Polite pacing between requests, never before the first.
    expect(pauses).toEqual([1000, 1000]);
    expect(out.failures).toEqual([]);
    expect(out.resolved.map((m) => m.refId)).toEqual([
      '2505.09388',
      '10.1145/3580305',
      '2107.03374',
      '1412.6980',
    ]);
  });

  it('collects per-ref failures instead of failing the run', async () => {
    const { fetch } = recordingFetch((url) =>
      url.includes('export.arxiv.org')
        ? xmlResponse(feed([{ id: 'http://arxiv.org/abs/2505.09388v1', title: 'Kept' }]))
        : new Response('', { status: 500 }),
    );
    const out = await resolveDemandRefs(
      [
        { refKind: 'arxiv', refId: '2505.09388' },
        { refKind: 'arxiv', refId: '2110.14168' },
        { refKind: 'doi', refId: '10.1145/3580305' },
      ],
      { fetch, sleep: noSleep },
    );

    expect(out.resolved.map((m) => m.refId)).toEqual(['2505.09388']);
    expect(out.failures).toEqual([
      { refKind: 'arxiv', refId: '2110.14168', reason: 'no arxiv entry', retryable: false },
      { refKind: 'doi', refId: '10.1145/3580305', reason: 'http 500', retryable: true },
    ]);
  });

  it('makes no requests for an empty ref list', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({}));
    expect(await resolveDemandRefs([], { fetch, sleep: noSleep })).toEqual({
      resolved: [],
      failures: [],
    });
    expect(calls).toHaveLength(0);
  });
});

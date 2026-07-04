import { describe, it, expect } from 'vitest';

import { normalizeDoi, resolveOa } from '../src/shared/unpaywall.js';

const EMAIL = 'chiya@example.com';

function fakeFetch(
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('normalizeDoi', () => {
  it('strips https://doi.org/ prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1038/s41586-020-2649-2')).toBe(
      '10.1038/s41586-020-2649-2',
    );
  });

  it('strips dx.doi.org and doi: forms', () => {
    expect(normalizeDoi('http://dx.doi.org/10.1145/3580305')).toBe('10.1145/3580305');
    expect(normalizeDoi('doi:10.1145/3580305')).toBe('10.1145/3580305');
  });

  it('lowercases and trims', () => {
    expect(normalizeDoi('  10.1002/ADMA.202300123  ')).toBe('10.1002/adma.202300123');
  });
});

describe('resolveOa', () => {
  it('returns oa with pdf preferred when url_for_pdf is present', async () => {
    const fetch = fakeFetch((url) => {
      expect(url).toContain('api.unpaywall.org/v2/10.1038%2Ffoo');
      expect(url).toContain(`email=${encodeURIComponent(EMAIL)}`);
      return jsonResponse({
        is_oa: true,
        best_oa_location: {
          url: 'https://europepmc.org/article/MED/1',
          url_for_pdf: 'https://europepmc.org/article/MED/1/pdf',
          url_for_landing_page: 'https://europepmc.org/article/MED/1',
          host_type: 'repository',
          version: 'acceptedVersion',
          license: 'cc-by',
        },
      });
    });
    const result = await resolveOa('10.1038/foo', EMAIL, { fetch });
    expect(result.status).toBe('oa');
    if (result.status === 'oa') {
      expect(result.location.url).toBe('https://europepmc.org/article/MED/1/pdf');
      expect(result.location.pdfUrl).toBe('https://europepmc.org/article/MED/1/pdf');
      expect(result.location.hostType).toBe('repository');
      expect(result.location.version).toBe('acceptedVersion');
      expect(result.location.license).toBe('cc-by');
    }
  });

  it('falls back to url then landing page when pdf is absent', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({
        is_oa: true,
        best_oa_location: {
          url: 'https://arxiv.org/abs/2403.1',
          url_for_pdf: null,
          url_for_landing_page: 'https://arxiv.org/abs/2403.1',
        },
      }),
    );
    const result = await resolveOa('10.48550/arxiv.2403.1', EMAIL, { fetch });
    expect(result.status).toBe('oa');
    if (result.status === 'oa') {
      expect(result.location.url).toBe('https://arxiv.org/abs/2403.1');
      expect(result.location.pdfUrl).toBeNull();
    }
  });

  it('returns closed when is_oa is false', async () => {
    const fetch = fakeFetch(() => jsonResponse({ is_oa: false, best_oa_location: null }));
    expect(await resolveOa('10.1126/science.abc', EMAIL, { fetch })).toEqual({ status: 'closed' });
  });

  it('returns closed when is_oa is true but no location is fetchable', async () => {
    const fetch = fakeFetch(() => jsonResponse({ is_oa: true, best_oa_location: null }));
    expect(await resolveOa('10.1/x', EMAIL, { fetch })).toEqual({ status: 'closed' });
  });

  it('returns not-found on 404 and 422', async () => {
    const fetch404 = fakeFetch(() => new Response('{}', { status: 404 }));
    expect(await resolveOa('10.9999/unknown', EMAIL, { fetch: fetch404 })).toEqual({
      status: 'not-found',
    });
    const fetch422 = fakeFetch(() => new Response('{}', { status: 422 }));
    expect(await resolveOa('not-a-doi', EMAIL, { fetch: fetch422 })).toEqual({
      status: 'not-found',
    });
  });

  it('returns retryable error on 429 and 5xx', async () => {
    const fetch429 = fakeFetch(() => new Response('slow down', { status: 429 }));
    const r429 = await resolveOa('10.1/x', EMAIL, { fetch: fetch429 });
    expect(r429.status).toBe('error');
    if (r429.status === 'error') expect(r429.reason).toBe('http 429');

    const fetch503 = fakeFetch(() => new Response('down', { status: 503 }));
    const r503 = await resolveOa('10.1/x', EMAIL, { fetch: fetch503 });
    expect(r503.status).toBe('error');
  });

  it('returns error on network failure without throwing', async () => {
    const fetch = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const result = await resolveOa('10.1/x', EMAIL, { fetch });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.reason).toContain('ECONNRESET');
  });

  it('returns error on invalid json body', async () => {
    const fetch = fakeFetch(() => new Response('<html>proxy error</html>', { status: 200 }));
    const result = await resolveOa('10.1/x', EMAIL, { fetch });
    expect(result).toEqual({ status: 'error', reason: 'invalid json from unpaywall' });
  });

  it('refuses to run without a plausible contact email', async () => {
    let called = false;
    const fetch = fakeFetch(() => {
      called = true;
      return jsonResponse({});
    });
    const result = await resolveOa('10.1/x', '', { fetch });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.reason).toContain('contact email');
    expect(called).toBe(false);
  });

  it('returns not-found for an empty DOI without calling the API', async () => {
    let called = false;
    const fetch = fakeFetch(() => {
      called = true;
      return jsonResponse({});
    });
    expect(await resolveOa('  ', EMAIL, { fetch })).toEqual({ status: 'not-found' });
    expect(called).toBe(false);
  });
});

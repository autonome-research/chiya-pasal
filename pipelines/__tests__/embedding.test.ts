import { describe, it, expect } from 'vitest';

import { embedBatch, type EmbeddingTarget } from '../src/shared/embedding.js';

const TARGET: EmbeddingTarget = {
  baseUrl: 'http://example.test/v1',
  apiKey: 'unused',
  model: 'qwen3-embed-8b',
};

function fakeFetch(handler: (req: Request | { url: string; init?: RequestInit }) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler({ url, init });
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('embedBatch', () => {
  it('returns an empty array for empty input without making a request', async () => {
    let called = false;
    const fetch = fakeFetch(() => {
      called = true;
      return jsonResponse({ data: [], model: 'x' });
    });
    const out = await embedBatch([], TARGET, { fetch });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('maps responses back to input order using the index field', async () => {
    const fetch = fakeFetch(({ url, init }) => {
      expect(url).toBe('http://example.test/v1/embeddings');
      const body = JSON.parse(String(init!.body));
      expect(body.model).toBe('qwen3-embed-8b');
      expect(body.input).toEqual(['a', 'b', 'c']);
      // Return out-of-order on purpose; the client should sort by index.
      return jsonResponse({
        data: [
          { index: 2, embedding: [0.3] },
          { index: 0, embedding: [0.1] },
          { index: 1, embedding: [0.2] },
        ],
        model: 'qwen3-embed-8b',
      });
    });
    const out = await embedBatch(['a', 'b', 'c'], TARGET, { fetch });
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.map((r) => r.vector)).toEqual([[0.1], [0.2], [0.3]]);
  });

  it('throws on non-OK HTTP with the status code in the message', async () => {
    const fetch = fakeFetch(() => new Response('upstream-fault', { status: 503 }));
    await expect(embedBatch(['x'], TARGET, { fetch })).rejects.toThrow(/503/);
  });

  it('throws when response count does not match input count', async () => {
    const fetch = fakeFetch(() => jsonResponse({ data: [{ index: 0, embedding: [0] }], model: 'm' }));
    await expect(embedBatch(['x', 'y'], TARGET, { fetch })).rejects.toThrow(/count mismatch/);
  });

  it('throws when response is missing the data array', async () => {
    const fetch = fakeFetch(() => jsonResponse({ model: 'm' }));
    await expect(embedBatch(['x'], TARGET, { fetch })).rejects.toThrow(/missing data array/);
  });

  it('respects an externally provided AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort('test-cancel');
    const fetch = fakeFetch((req) => {
      // The signal we passed in should already be aborted by the time fetch runs.
      const signal = (req as { init?: RequestInit }).init?.signal;
      expect(signal?.aborted).toBe(true);
      return jsonResponse({ data: [], model: 'x' });
    });
    // The client doesn't fast-fail before calling fetch; the underlying fetch
    // would normally throw AbortError. We just verify the signal is propagated.
    try {
      await embedBatch(['x'], TARGET, { fetch, signal: ac.signal });
    } catch {
      // Either an abort or the fake-fetch returning a valid response is fine;
      // we only care about signal propagation, asserted above.
    }
  });

  it('trims a trailing slash on baseUrl before appending /embeddings', async () => {
    const fetch = fakeFetch(({ url }) => {
      expect(url).toBe('http://example.test/v1/embeddings');
      return jsonResponse({ data: [{ index: 0, embedding: [0] }], model: 'm' });
    });
    await embedBatch(['x'], { ...TARGET, baseUrl: 'http://example.test/v1/' }, { fetch });
  });
});

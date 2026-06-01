import { describe, expect, it } from 'vitest';

import { fetchJson } from '../src/collection/fetch.js';

describe('source fetch policy', () => {
  it('retries retryable HTTP failures', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return calls === 1
        ? new Response('bad gateway', { status: 502 })
        : Response.json({ ok: true });
    };

    const result = await fetchJson<{ ok: boolean }>({
      source: 'test-source',
      url: 'https://example.com/api',
      ctx: { now: new Date(0), interests: {}, fetch: fakeFetch },
      retries: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ok: true });
      expect(result.attempts).toBe(2);
    }
    expect(calls).toBe(2);
  });

  it('honors retries=0', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return new Response('bad gateway', { status: 502 });
    };

    const result = await fetchJson({
      source: 'test-source',
      url: 'https://example.com/api',
      ctx: { now: new Date(0), interests: {}, fetch: fakeFetch },
      retries: 0,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('cancels non-ok response bodies before retrying', async () => {
    let cancelled = false;
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 502 });
      }
      return Response.json({ ok: true });
    };

    const result = await fetchJson({
      source: 'test-source',
      url: 'https://example.com/api',
      ctx: { now: new Date(0), interests: {}, fetch: fakeFetch },
      retries: 1,
    });

    expect(result.ok).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('returns a source report after exhausted retries', async () => {
    const fakeFetch: typeof fetch = async () => new Response('rate limited', { status: 429 });

    const result = await fetchJson({
      source: 'test-source',
      url: 'https://example.com/api',
      ctx: { now: new Date(0), interests: {}, fetch: fakeFetch },
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.source).toBe('test-source');
      expect(result.report.warnings.join(' ')).toContain('http 429');
      expect(result.report.warnings.join(' ')).toContain('health:attempts=2');
    }
  });
});

/**
 * Web fetcher — single GET with timeout, returns text body. Used by the
 * librarian when an article's queue file abstract is too thin.
 *
 * Wrapper around node fetch with a sane default timeout and a max-bytes cap
 * to avoid pulling down arbitrary HTML pages.
 */

import type { ToolRegistry } from 'thread-phase';

export interface WebFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

const DEFAULTS: Required<WebFetchOptions> = {
  timeoutMs: 10_000,
  maxBytes: 200_000,
  userAgent: 'chiya-pipelines/0.0.1',
};

export async function webFetch(url: string, options: WebFetchOptions = {}): Promise<string> {
  const opts = { ...DEFAULTS, ...options };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': opts.userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      return `[fetch error: ${res.status} ${res.statusText}]`;
    }
    const text = await res.text();
    return text.length > opts.maxBytes
      ? text.slice(0, opts.maxBytes) + `\n\n[truncated at ${opts.maxBytes} bytes]`
      : text;
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') return `[fetch error: timeout after ${opts.timeoutMs}ms]`;
    return `[fetch error: ${e.message ?? String(err)}]`;
  } finally {
    clearTimeout(timer);
  }
}

export function registerWebTools(registry: ToolRegistry, options: WebFetchOptions = {}): void {
  registry.register(
    {
      name: 'web_fetch',
      description:
        'Fetch a URL and return the response body as text. Use for thin article abstracts that need the actual page content.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL including scheme' } },
        required: ['url'],
      },
    },
    async ({ url }) => webFetch(String(url), options),
  );
}

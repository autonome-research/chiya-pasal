import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';

import {
  fetchDocumentText,
  htmlToText,
  pdfToText,
  TEXT_CAP,
} from '../src/shared/fulltext.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as unknown as typeof fetch;
}

/** Build a fake child process that plays out a scripted pdftotext run. */
function fakeSpawn(script: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  emitError?: Error;
  neverExit?: boolean;
}): typeof spawn {
  return ((_cmd: string, _args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: (b?: Buffer) => void; on: (e: string, f: () => void) => void };
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: () => undefined, on: () => undefined };
    proc.kill = () => undefined;

    queueMicrotask(() => {
      if (script.emitError) {
        proc.emit('error', script.emitError);
        return;
      }
      if (script.stdout) proc.stdout.emit('data', Buffer.from(script.stdout));
      if (script.stderr) proc.stderr.emit('data', Buffer.from(script.stderr));
      if (!script.neverExit) proc.emit('close', script.exitCode ?? 0);
    });
    return proc;
  }) as unknown as typeof spawn;
}

// ---------------------------------------------------------------------------
// htmlToText (canonical home is now this module)
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('strips tags, scripts, and decodes entities', () => {
    const out = htmlToText('<p>a &amp; b</p><script>x()</script><p>c</p>');
    expect(out).toBe('a & b\nc');
  });

  it('caps at TEXT_CAP', () => {
    expect(htmlToText('y'.repeat(TEXT_CAP + 5000)).length).toBe(TEXT_CAP);
  });
});

// ---------------------------------------------------------------------------
// pdfToText
// ---------------------------------------------------------------------------

describe('pdfToText', () => {
  const pdfBytes = Buffer.from('%PDF-1.4 fake');

  it('returns extracted text with whitespace normalized (newline runs collapse)', async () => {
    const result = await pdfToText(pdfBytes, {
      spawnFn: fakeSpawn({ stdout: 'Extracted   text\n\n\n\nacross pages' }),
    });
    expect(result).toEqual({ ok: true, text: 'Extracted text\nacross pages' });
  });

  it('reports a typed error when the binary is missing (ENOENT)', async () => {
    const result = await pdfToText(pdfBytes, {
      spawnFn: fakeSpawn({ emitError: Object.assign(new Error('spawn pdftotext ENOENT')) }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unavailable');
  });

  it('reports non-zero exit with stderr context', async () => {
    const result = await pdfToText(pdfBytes, {
      spawnFn: fakeSpawn({ exitCode: 1, stderr: 'Syntax Error: broken xref' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('exit 1');
  });

  it('treats empty output as failure (scanned/image pdf)', async () => {
    const result = await pdfToText(pdfBytes, { spawnFn: fakeSpawn({ stdout: '   \n  ' }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no text');
  });

  it('times out a hung process', async () => {
    const result = await pdfToText(pdfBytes, {
      spawnFn: fakeSpawn({ neverExit: true }),
      timeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// fetchDocumentText
// ---------------------------------------------------------------------------

describe('fetchDocumentText', () => {
  it('extracts HTML documents via htmlToText', async () => {
    const fetch = fakeFetch(() =>
      new Response('<html><body><p>Full text here.</p></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const result = await fetchDocumentText('https://example.com/paper', { fetch });
    expect(result).toEqual({ ok: true, text: 'Full text here.', kind: 'html' });
  });

  it('detects PDFs by magic bytes even with a lying content-type', async () => {
    const pdfBody = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(64, 0x20)]);
    const fetch = fakeFetch(() =>
      new Response(pdfBody, { headers: { 'content-type': 'text/html' } }),
    );
    const extracted: Buffer[] = [];
    const result = await fetchDocumentText('https://example.com/really.pdf', {
      fetch,
      pdfExtractor: async (buf) => {
        extracted.push(buf);
        return { ok: true, text: 'pdf text content' };
      },
    });
    expect(result).toEqual({ ok: true, text: 'pdf text content', kind: 'pdf' });
    expect(extracted[0]!.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('routes application/pdf content-type to the pdf extractor', async () => {
    const fetch = fakeFetch(() =>
      new Response(Buffer.from('not-really-pdf-bytes'), {
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    const result = await fetchDocumentText('https://example.com/x', {
      fetch,
      pdfExtractor: async () => ({ ok: true, text: 'from pdf' }),
    });
    expect(result).toEqual({ ok: true, text: 'from pdf', kind: 'pdf' });
  });

  it('propagates pdf extraction failure as non-retryable', async () => {
    const fetch = fakeFetch(() =>
      new Response(Buffer.from('%PDF-1.5'), { headers: { 'content-type': 'application/pdf' } }),
    );
    const result = await fetchDocumentText('https://example.com/x', {
      fetch,
      pdfExtractor: async () => ({ ok: false, reason: 'no text layer' }),
    });
    expect(result).toEqual({ ok: false, reason: 'no text layer', retryable: false });
  });

  it('passes plain text through with whitespace normalization', async () => {
    const fetch = fakeFetch(() =>
      new Response('line one   \n\n   line two', { headers: { 'content-type': 'text/plain' } }),
    );
    const result = await fetchDocumentText('https://example.com/notes.txt', { fetch });
    expect(result).toEqual({ ok: true, text: 'line one\nline two', kind: 'text' });
  });

  it('marks 429 and 5xx as retryable, 404 as not', async () => {
    const r429 = await fetchDocumentText('https://x.test/a', {
      fetch: fakeFetch(() => new Response('', { status: 429 })),
    });
    expect(r429).toMatchObject({ ok: false, retryable: true });

    const r503 = await fetchDocumentText('https://x.test/b', {
      fetch: fakeFetch(() => new Response('', { status: 503 })),
    });
    expect(r503).toMatchObject({ ok: false, retryable: true });

    const r404 = await fetchDocumentText('https://x.test/c', {
      fetch: fakeFetch(() => new Response('', { status: 404 })),
    });
    expect(r404).toMatchObject({ ok: false, reason: 'http 404', retryable: false });
  });

  it('returns retryable on network failure without throwing', async () => {
    const fetch = (() => Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof fetch;
    const result = await fetchDocumentText('https://x.test/net', { fetch });
    expect(result).toMatchObject({ ok: false, retryable: true });
    if (!result.ok) expect(result.reason).toContain('ETIMEDOUT');
  });

  it('rejects empty html-stripped documents', async () => {
    const fetch = fakeFetch(() =>
      new Response('<html><script>only(scripts)</script></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const result = await fetchDocumentText('https://x.test/empty', { fetch });
    expect(result).toMatchObject({ ok: false, reason: 'html stripped to empty' });
  });
});

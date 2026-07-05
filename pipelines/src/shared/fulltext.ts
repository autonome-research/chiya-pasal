/**
 * Document-text extraction mechanisms for the shared enrich phase.
 *
 * This module owns the HOW of turning a URL into plain text: HTTP fetch,
 * content-type sniffing, HTML stripping, PDF extraction. The WHICH-URLS-
 * IN-WHAT-ORDER policy (arXiv-HTML-first, Unpaywall fallback, abstract
 * last) lives in the enrich phase — keep transport and policy separable
 * so each can be tested and replaced on its own.
 *
 * PDF extraction shells out to poppler's `pdftotext` (stdin → stdout).
 * The binary's absence or failure degrades gracefully to a typed error —
 * callers fall down their ladder instead of crashing the batch.
 */

import { spawn } from 'child_process';

/** Cap on extracted text. Summaries don't benefit past this, and it keeps
 *  prompt sizes and DB rows bounded. */
export const TEXT_CAP = 50_000;

/** Cap on downloaded bytes before extraction (PDFs can be huge scans). */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_PDF_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'chiya-shared/1.0';

/**
 * Minimal HTML→plain-text pass. Not a full parser:
 *   - Drop <script> / <style> blocks (with content) entirely.
 *   - Turn block-ish open tags (<br>, <p>, <div>, <li>) into newlines.
 *   - Strip everything else that looks like a tag.
 *   - Decode the small set of HTML entities we actually see in the wild.
 *   - Collapse whitespace runs and cap length.
 *
 * (Moved from librarian-phases.ts; the librarian re-exports it until its
 * enrich phase is retired in the multi-tenant cutover.)
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html;
  // Drop script/style blocks (with their contents) before any other tag pass.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  // Block-ish open tags become newlines so paragraph boundaries survive.
  s = s.replace(/<(?:br|p|div|li)\b[^>]*\/?>/gi, '\n');
  // Strip every remaining tag.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // Decode the entities we care about. Order matters for &amp;.
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  // Collapse whitespace runs. Keep newlines as a single \n separator.
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > TEXT_CAP) s = s.slice(0, TEXT_CAP);
  return s;
}

export type PdfExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export type PdfExtractor = (pdf: Buffer) => Promise<PdfExtractResult>;

export interface PdfToTextOptions {
  timeoutMs?: number;
  /** Injectable for tests — replaces the child-process spawn entirely. */
  spawnFn?: typeof spawn;
}

/**
 * Extract text from PDF bytes via `pdftotext -q -enc UTF-8 - -`.
 * Missing binary, non-zero exit, timeout, and empty output all come back
 * as typed errors — never throws.
 */
export async function pdfToText(pdf: Buffer, options: PdfToTextOptions = {}): Promise<PdfExtractResult> {
  const spawnFn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: PdfExtractResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawnFn('pdftotext', ['-q', '-enc', 'UTF-8', '-', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, reason: `pdftotext spawn failed: ${String(err).slice(0, 200)}` });
      return;
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      done({ ok: false, reason: `pdftotext timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < TEXT_CAP * 2) stdout += d.toString('utf-8');
    });
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8').slice(0, 500)));

    proc.on('error', (err) => {
      // ENOENT (binary not installed) lands here.
      done({ ok: false, reason: `pdftotext unavailable: ${err.message.slice(0, 200)}` });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        done({ ok: false, reason: `pdftotext exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      const text = stdout
        .replace(/[ \t\r\f\v]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, TEXT_CAP);
      if (text.length === 0) {
        done({ ok: false, reason: 'pdftotext produced no text (scanned/image pdf?)' });
        return;
      }
      done({ ok: true, text });
    });

    proc.stdin?.on('error', () => {
      // EPIPE when the process died early; the 'error'/'close' handlers own the outcome.
    });
    proc.stdin?.end(pdf);
  });
}

export type DocumentKind = 'html' | 'pdf' | 'text';

export type FetchDocumentResult =
  | { ok: true; text: string; kind: DocumentKind }
  | { ok: false; reason: string; retryable: boolean };

export interface FetchDocumentOptions {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable PDF extractor; defaults to pdfToText. */
  pdfExtractor?: PdfExtractor;
}

/**
 * Fetch a URL and extract plain text from whatever it turns out to be.
 * PDF detection is content-based (%PDF magic bytes) with the Content-Type
 * header as a hint — publishers routinely mislabel both directions.
 */
export async function fetchDocumentText(
  url: string,
  options: FetchDocumentOptions = {},
): Promise<FetchDocumentResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const extractPdf = options.pdfExtractor ?? ((buf: Buffer) => pdfToText(buf));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('fetch-timeout'), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener(
      'abort',
      () => controller.abort(options.signal!.reason),
      { once: true },
    );
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `fetch failed: ${reason.slice(0, 200)}`, retryable: true };
  }

  if (!res.ok) {
    clearTimeout(timer);
    const retryable = res.status === 429 || res.status >= 500;
    return { ok: false, reason: `http ${res.status}`, retryable };
  }

  let bytes: Buffer;
  try {
    const ab = await res.arrayBuffer();
    bytes = Buffer.from(ab);
  } catch (err) {
    return {
      ok: false,
      reason: `body read failed: ${String(err).slice(0, 200)}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }

  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false, reason: `document too large (${bytes.byteLength} bytes)`, retryable: false };
  }

  const contentType = res.headers.get('content-type') ?? '';
  const looksPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-' || /\bpdf\b/i.test(contentType);

  if (looksPdf) {
    const result = await extractPdf(bytes);
    if (!result.ok) return { ok: false, reason: result.reason, retryable: false };
    return { ok: true, text: result.text, kind: 'pdf' };
  }

  const raw = bytes.toString('utf-8');
  if (/^\s*</.test(raw) || /html/i.test(contentType)) {
    const text = htmlToText(raw);
    if (text.length === 0) return { ok: false, reason: 'html stripped to empty', retryable: false };
    return { ok: true, text, kind: 'html' };
  }

  const text = raw
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, TEXT_CAP);
  if (text.length === 0) return { ok: false, reason: 'empty document', retryable: false };
  return { ok: true, text, kind: 'text' };
}

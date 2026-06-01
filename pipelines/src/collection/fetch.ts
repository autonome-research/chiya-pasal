import { makeReport, type SourceRunReport, type SourceContext } from './source-adapter.js';

export interface FetchJsonOptions {
  source: string;
  url: string;
  ctx: SourceContext;
  headers?: HeadersInit;
  timeoutMs?: number;
  retries?: number;
}

export interface FetchTextOptions extends FetchJsonOptions {}

export type SourceFetchResult<T> = {
  ok: true;
  value: T;
  status: number;
  attempts: number;
  elapsedMs: number;
} | {
  ok: false;
  report: SourceRunReport;
  attempts: number;
  elapsedMs: number;
};

const DEFAULT_TIMEOUT_MS = envNumber('CHIYA_SOURCE_TIMEOUT_MS', 15000, 100);
const DEFAULT_RETRIES = envNumber('CHIYA_SOURCE_RETRIES', 1, 0);
const USER_AGENT = 'chiya-collector/0.1';

export async function fetchJson<T>(options: FetchJsonOptions): Promise<SourceFetchResult<T>> {
  return fetchWithPolicy(options, async (res) => await res.json() as T);
}

export async function fetchText(options: FetchTextOptions): Promise<SourceFetchResult<string>> {
  return fetchWithPolicy(options, async (res) => await res.text());
}

async function fetchWithPolicy<T>(
  options: FetchJsonOptions,
  readBody: (res: Response) => Promise<T>,
): Promise<SourceFetchResult<T>> {
  const fetchImpl = options.ctx.fetch ?? globalThis.fetch;
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  const warnings: string[] = [];

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(`source-timeout-${timeoutMs}ms`), timeoutMs);
    const releaseParent = linkAbort(options.ctx.signal, controller);
    try {
      const headers = new Headers(options.headers);
      if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
      const res = await fetchImpl(options.url, {
        signal: controller.signal,
        headers,
      });
      if (!res.ok) {
        const warning = `http ${res.status}${attempt <= retries && shouldRetryStatus(res.status) ? ` attempt=${attempt}` : ''}`;
        warnings.push(warning);
        await cancelBody(res);
        if (attempt <= retries && shouldRetryStatus(res.status)) {
          await retryDelay(attempt);
          continue;
        }
        return {
          ok: false,
          attempts: attempt,
          elapsedMs: Date.now() - started,
          report: makeReport(options.source, { warnings: addTiming(warnings, attempt, started) }),
        };
      }
      const value = await readBody(res);
      return { ok: true, value, status: res.status, attempts: attempt, elapsedMs: Date.now() - started };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = controller.signal.aborted && !options.ctx.signal?.aborted
        ? String(controller.signal.reason ?? rawMsg)
        : rawMsg;
      warnings.push(`fetch-error attempt=${attempt}: ${msg.slice(0, 120)}`);
      if (attempt > retries || options.ctx.signal?.aborted) {
        return {
          ok: false,
          attempts: attempt,
          elapsedMs: Date.now() - started,
          report: makeReport(options.source, { warnings: addTiming(warnings, attempt, started) }),
        };
      }
      await retryDelay(attempt);
    } finally {
      clearTimeout(timeout);
      releaseParent();
    }
  }

  return {
    ok: false,
    attempts: retries + 1,
    elapsedMs: Date.now() - started,
    report: makeReport(options.source, { warnings: addTiming(warnings, retries + 1, started) }),
  };
}

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Body cleanup is best-effort only.
  }
}

async function retryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 150 * attempt)));
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function addTiming(warnings: string[], attempts: number, started: number): string[] {
  return [...warnings, `health:attempts=${attempts}`, `health:elapsedMs=${Date.now() - started}`];
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => undefined;
  const onAbort = () => child.abort(parent.reason);
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

export function healthWarnings(attempts: number, elapsedMs: number): string[] {
  const out: string[] = [`health:elapsedMs=${elapsedMs}`];
  if (attempts > 1) out.push(`health:attempts=${attempts}`);
  return out;
}

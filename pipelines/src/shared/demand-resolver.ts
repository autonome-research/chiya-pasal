/**
 * Metadata resolver for demand-driven (tier-3) citation ingestion.
 *
 * The citation demand ledger only knows identifiers: `arxiv:2107.03374`,
 * `doi:10.1145/3580305`. To hand a paper to the shared pipeline we need a
 * title, a fetchable canonical URL, and ideally an abstract. Two free APIs
 * cover the whole ledger:
 *
 *   arXiv   GET http://export.arxiv.org/api/query?id_list=a,b,c&max_results=N
 *           Atom feed, batched — one request per ~20 ids.
 *   Crossref GET https://api.crossref.org/works/<doi>[?mailto=...]
 *           JSON, one request per DOI (no usable batch endpoint).
 *
 * Same contract as `unpaywall.ts`: a discriminated-union result per ref, an
 * injectable fetch, a hard timeout, and transient-vs-terminal classification.
 * Nothing here throws for a bad ref — the caller counts the reason and moves
 * on, because one unresolvable citation must never fail a whole run.
 *
 * The canonical URL is load-bearing: it MUST be the URL form that
 * `stableIdForUrl` maps back to the ref's stable id, so an emitted article
 * dedups against a copy that arrives later through normal collection.
 */

import { stableIdForUrl, stableIdToFilename } from '../phases/page-templates.js';
import { normalizeDoi } from './unpaywall.js';

export type RefKind = 'arxiv' | 'doi';

export interface DemandRef {
  refKind: RefKind;
  refId: string;
}

export interface RefMetadata {
  refKind: RefKind;
  refId: string;
  /** Canonical URL — round-trips through stableIdForUrl to the ref's stable id. */
  url: string;
  title: string;
  abstract: string | null;
  /** Where the metadata came from ('arXiv' | 'Crossref'). */
  metadataSource: string;
}

export type RefMetadataResult =
  | { status: 'ok'; metadata: RefMetadata }
  | { status: 'not-found'; reason: string }
  | { status: 'error'; reason: string; retryable: boolean };

export interface DemandResolverOptions {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Contact address for the polite pools (arXiv UA, Crossref mailto). */
  contactEmail?: string | null;
  /** arXiv ids per id_list request. */
  batchSize?: number;
  /** Pause between HTTP requests — both APIs ask for ~1 req/s. */
  pauseMs?: number;
  /** Injectable for tests so pacing costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DemandResolution {
  /** Input order preserved, so a citer-count ordering survives resolution. */
  resolved: RefMetadata[];
  failures: Array<{ refKind: RefKind; refId: string; reason: string; retryable: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_PAUSE_MS = 1_000;
const ARXIV_API = 'http://export.arxiv.org/api/query';
const CROSSREF_API = 'https://api.crossref.org/works';
const MAX_ABSTRACT_CHARS = 600;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function userAgent(contactEmail?: string | null): string {
  const contact = contactEmail && contactEmail.includes('@') ? ` (mailto:${contactEmail})` : '';
  return `chiya-library/1.0${contact}`;
}

/** Bare arXiv id: no `arXiv:` scheme, no abs/pdf URL wrapper, no version. */
export function normalizeArxivId(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(?:www\.|export\.|api\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/^arxiv:/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/v\d+$/i, '')
    .trim();
}

/**
 * Canonical URL for a ledger ref, or null when the id is unusable.
 * arXiv → https://arxiv.org/abs/<id>, DOI → https://doi.org/<doi>.
 */
export function canonicalRefUrl(refKind: RefKind, refId: string): string | null {
  if (refKind === 'arxiv') {
    const id = normalizeArxivId(refId);
    return id ? `https://arxiv.org/abs/${id}` : null;
  }
  const doi = normalizeDoi(refId);
  return doi.startsWith('10.') ? `https://doi.org/${doi}` : null;
}

/**
 * The stable id a demanded ref will occupy once ingested — the whole basis
 * of the "is this already satisfied?" check.
 *
 * Deliberately routed through the SAME `stableIdForUrl` the absorb path uses
 * rather than reimplementing the normalization: `2301.03728` and
 * `2301.03728v2` both land on `arxiv-2301-03728`, and a DOI lands on
 * `doi-10-1145-3580305`. Returns null when the id doesn't parse as its
 * declared kind (a url-hash fallback would be a silent wrong answer).
 */
export function demandRefStableId(refKind: RefKind, refId: string): string | null {
  const url = canonicalRefUrl(refKind, refId);
  if (!url) return null;
  const sid = stableIdForUrl(url);
  if (!sid || sid.kind !== refKind) return null;
  return stableIdToFilename(sid);
}

// ---- shared HTTP plumbing ---------------------------------------------------

type FetchOutcome =
  | { kind: 'response'; res: Response }
  | { kind: 'error'; reason: string; retryable: boolean };

async function fetchWithTimeout(
  url: string,
  options: DemandResolverOptions,
): Promise<FetchOutcome> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('demand-resolver-timeout'), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else
      options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), {
        once: true,
      });
  }

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': userAgent(options.contactEmail) },
    });
    return { kind: 'response', res };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // AbortError from our own timer is retryable; an abort from the caller's
    // shutdown signal is too — the run just ends first.
    return { kind: 'error', reason: reason.slice(0, 200), retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** 429 and 5xx are worth retrying tomorrow; other non-2xx are not. */
function httpError(status: number): { reason: string; retryable: boolean } {
  return { reason: `http ${status}`, retryable: status === 429 || status >= 500 };
}

// ---- text cleanup -----------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** `String.fromCodePoint` throws above 0x10FFFF — a malformed numeric
 *  reference in one feed entry must not take down a whole run, so an
 *  out-of-range reference is left as literal text instead. */
function codePointOr(match: string, cp: number): string {
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => codePointOr(m, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec: string) => codePointOr(m, parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Collapse API prose into one clean line. arXiv wraps abstracts at ~80 cols;
 * Crossref returns JATS-tagged XML (`<jats:p>…`). Both must end up as a
 * single-line snippet because the matcha article format is line-oriented.
 */
export function cleanProse(raw: string | null | undefined, maxChars = MAX_ABSTRACT_CHARS): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

// ---- arXiv ------------------------------------------------------------------

function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse an arXiv Atom feed into bare-id → metadata.
 *
 * arXiv answers an unknown id with an entry whose `<id>` points at
 * `.../api/errors#...` and whose title is `Error`; those are dropped here so
 * the caller sees them as not-found rather than ingesting a page called
 * "Error".
 */
export function parseArxivFeed(xml: string): Map<string, { title: string; abstract: string | null }> {
  const out = new Map<string, { title: string; abstract: string | null }>();
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1] ?? '';
    const rawId = tagText(entry, 'id');
    if (!rawId || rawId.includes('/api/errors')) continue;
    const id = normalizeArxivId(rawId.trim());
    if (!id) continue;
    const title = cleanProse(tagText(entry, 'title'), 500);
    if (!title || title === 'Error') continue;
    out.set(id, { title, abstract: cleanProse(tagText(entry, 'summary')) });
  }
  return out;
}

/** One batched arXiv lookup. Every requested id gets a result. */
export async function resolveArxivBatch(
  ids: readonly string[],
  options: DemandResolverOptions = {},
): Promise<Map<string, RefMetadataResult>> {
  const out = new Map<string, RefMetadataResult>();
  const wanted = ids.map((id) => ({ raw: id, bare: normalizeArxivId(id) }));
  const queryable = wanted.filter((w) => w.bare.length > 0);
  for (const w of wanted) {
    if (!w.bare) out.set(w.raw, { status: 'not-found', reason: 'unparseable arxiv id' });
  }
  if (queryable.length === 0) return out;

  // max_results defaults to 10 — without it a batch larger than 10 silently
  // truncates and the tail looks like "not found".
  const url =
    `${ARXIV_API}?id_list=${encodeURIComponent(queryable.map((w) => w.bare).join(','))}` +
    `&max_results=${queryable.length}`;
  const outcome = await fetchWithTimeout(url, options);
  if (outcome.kind === 'error') {
    for (const w of queryable) {
      out.set(w.raw, { status: 'error', reason: outcome.reason, retryable: outcome.retryable });
    }
    return out;
  }
  if (!outcome.res.ok) {
    const { reason, retryable } = httpError(outcome.res.status);
    for (const w of queryable) out.set(w.raw, { status: 'error', reason, retryable });
    return out;
  }

  let xml: string;
  try {
    xml = await outcome.res.text();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const w of queryable) {
      out.set(w.raw, { status: 'error', reason: reason.slice(0, 200), retryable: true });
    }
    return out;
  }

  let parsed: ReturnType<typeof parseArxivFeed>;
  try {
    parsed = parseArxivFeed(xml);
  } catch (err) {
    // Contract: one malformed feed entry never fails the whole run.
    const reason = `arxiv feed parse: ${err instanceof Error ? err.message : String(err)}`;
    for (const w of queryable) {
      out.set(w.raw, { status: 'error', reason: reason.slice(0, 200), retryable: false });
    }
    return out;
  }
  for (const w of queryable) {
    const hit = parsed.get(w.bare);
    if (!hit) {
      out.set(w.raw, { status: 'not-found', reason: 'no arxiv entry' });
      continue;
    }
    out.set(w.raw, {
      status: 'ok',
      metadata: {
        refKind: 'arxiv',
        refId: w.raw,
        url: `https://arxiv.org/abs/${w.bare}`,
        title: hit.title,
        abstract: hit.abstract,
        metadataSource: 'arXiv',
      },
    });
  }
  return out;
}

// ---- Crossref ---------------------------------------------------------------

interface CrossrefMessage {
  title?: string[] | null;
  abstract?: string | null;
  'container-title'?: string[] | null;
}

/** One DOI lookup against Crossref. */
export async function resolveCrossrefDoi(
  doi: string,
  options: DemandResolverOptions = {},
): Promise<RefMetadataResult> {
  const normalized = normalizeDoi(doi);
  if (!normalized.startsWith('10.')) {
    return { status: 'not-found', reason: 'unparseable doi' };
  }

  const mailto =
    options.contactEmail && options.contactEmail.includes('@')
      ? `?mailto=${encodeURIComponent(options.contactEmail)}`
      : '';
  const outcome = await fetchWithTimeout(
    `${CROSSREF_API}/${encodeURIComponent(normalized)}${mailto}`,
    options,
  );
  if (outcome.kind === 'error') {
    return { status: 'error', reason: outcome.reason, retryable: outcome.retryable };
  }
  if (outcome.res.status === 404) return { status: 'not-found', reason: 'doi unknown to crossref' };
  if (!outcome.res.ok) {
    const { reason, retryable } = httpError(outcome.res.status);
    return { status: 'error', reason, retryable };
  }

  let json: { message?: CrossrefMessage | null };
  try {
    json = (await outcome.res.json()) as { message?: CrossrefMessage | null };
  } catch {
    return { status: 'error', reason: 'invalid json from crossref', retryable: false };
  }

  try {
    const title = cleanProse(json.message?.title?.[0], 500);
    if (!title) return { status: 'not-found', reason: 'crossref record has no title' };

    return {
      status: 'ok',
      metadata: {
        refKind: 'doi',
        refId: doi,
        url: `https://doi.org/${normalized}`,
        title,
        abstract: cleanProse(json.message?.abstract),
        metadataSource: 'Crossref',
      },
    };
  } catch (err) {
    const reason = `crossref record parse: ${err instanceof Error ? err.message : String(err)}`;
    return { status: 'error', reason: reason.slice(0, 200), retryable: false };
  }
}

// ---- orchestration ----------------------------------------------------------

/**
 * Resolve a mixed list of demanded refs: arXiv ids batched, DOIs one at a
 * time, one polite pause between HTTP requests. Failures are collected, never
 * thrown — a run that resolves 20 of 25 refs emits 20 articles.
 */
export async function resolveDemandRefs(
  refs: readonly DemandRef[],
  options: DemandResolverOptions = {},
): Promise<DemandResolution> {
  const sleep = options.sleep ?? defaultSleep;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  const results = new Map<string, RefMetadataResult>();
  const key = (r: DemandRef): string => `${r.refKind}:${r.refId}`;
  let requests = 0;
  const pace = async (): Promise<void> => {
    if (requests > 0 && pauseMs > 0) await sleep(pauseMs);
    requests++;
  };

  const arxivRefs = refs.filter((r) => r.refKind === 'arxiv');
  for (let i = 0; i < arxivRefs.length; i += batchSize) {
    const chunk = arxivRefs.slice(i, i + batchSize);
    await pace();
    const batch = await resolveArxivBatch(
      chunk.map((r) => r.refId),
      options,
    );
    for (const r of chunk) {
      results.set(key(r), batch.get(r.refId) ?? { status: 'not-found', reason: 'no arxiv entry' });
    }
  }

  for (const r of refs) {
    if (r.refKind !== 'doi') continue;
    await pace();
    results.set(key(r), await resolveCrossrefDoi(r.refId, options));
  }

  const resolved: RefMetadata[] = [];
  const failures: DemandResolution['failures'] = [];
  for (const r of refs) {
    const result = results.get(key(r)) ?? { status: 'not-found' as const, reason: 'not attempted' };
    if (result.status === 'ok') resolved.push(result.metadata);
    else
      failures.push({
        refKind: r.refKind,
        refId: r.refId,
        reason: result.reason,
        retryable: result.status === 'error' ? result.retryable : false,
      });
  }
  return { resolved, failures };
}

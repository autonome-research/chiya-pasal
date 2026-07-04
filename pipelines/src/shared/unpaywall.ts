/**
 * Unpaywall open-access resolver.
 *
 * Middle rung of the shared enrich ladder: when an article's own URL is
 * paywalled or yields no useful text, ask Unpaywall whether a legal OA copy
 * exists (author preprint, PMC version, institutional repository). Free API,
 * no key — just a contact email in the query string. ~100k calls/day cap;
 * we run ~315 articles/day.
 *
 *   GET https://api.unpaywall.org/v2/{doi}?email={email}
 *
 * Result semantics for the caller (the enrich phase):
 *   - 'oa'        → fetch location.url next (pdfUrl preferred when set)
 *   - 'closed'    → known DOI, no OA copy; fall back to abstract-only
 *   - 'not-found' → DOI unknown/malformed; fall back to abstract-only
 *   - 'error'     → transient (network/5xx/429); caller may retry later
 */

export interface OaLocation {
  /** Best fetchable URL: the PDF when Unpaywall has one, else the landing page. */
  url: string;
  pdfUrl: string | null;
  landingUrl: string | null;
  /** 'repository' (arXiv, PMC, institutional) or 'publisher'. */
  hostType: string | null;
  /** 'submittedVersion' | 'acceptedVersion' | 'publishedVersion'. */
  version: string | null;
  license: string | null;
}

export type UnpaywallResult =
  | { status: 'oa'; location: OaLocation }
  | { status: 'closed' }
  | { status: 'not-found' }
  | { status: 'error'; reason: string };

export interface ResolveOaOptions {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const API_BASE = 'https://api.unpaywall.org/v2';

interface ApiOaLocation {
  url?: string | null;
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
  host_type?: string | null;
  version?: string | null;
  license?: string | null;
}

interface ApiResponse {
  is_oa?: boolean;
  best_oa_location?: ApiOaLocation | null;
}

/**
 * Normalize a DOI for the API path: strip doi.org URL prefixes and a
 * leading 'doi:' scheme, trim, lowercase. Unpaywall matches DOIs
 * case-insensitively but canonical-lowercase keeps cache keys stable.
 */
export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim()
    .toLowerCase();
}

export async function resolveOa(
  doi: string,
  email: string,
  options: ResolveOaOptions = {},
): Promise<UnpaywallResult> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return { status: 'not-found' };
  if (!email || !email.includes('@')) {
    // Unpaywall requires a real contact address; failing loudly here beats
    // silently sending garbage and getting blocked.
    return { status: 'error', reason: 'unpaywall requires a contact email (CHIYA_UNPAYWALL_EMAIL)' };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('unpaywall-timeout'), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener(
      'abort',
      () => controller.abort(options.signal!.reason),
      { once: true },
    );
  }

  const url = `${API_BASE}/${encodeURIComponent(normalized)}?email=${encodeURIComponent(email)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'error', reason: reason.slice(0, 200) };
  }
  clearTimeout(timer);

  if (res.status === 404 || res.status === 422) {
    // 404 = unknown DOI; 422 = malformed DOI. Same caller behavior.
    return { status: 'not-found' };
  }
  if (res.status === 429 || res.status >= 500) {
    return { status: 'error', reason: `http ${res.status}` };
  }
  if (!res.ok) {
    return { status: 'error', reason: `unexpected http ${res.status}` };
  }

  let json: ApiResponse;
  try {
    json = (await res.json()) as ApiResponse;
  } catch {
    return { status: 'error', reason: 'invalid json from unpaywall' };
  }

  if (!json.is_oa) return { status: 'closed' };

  const loc = json.best_oa_location;
  const pdfUrl = loc?.url_for_pdf ?? null;
  const landingUrl = loc?.url_for_landing_page ?? null;
  const best = pdfUrl ?? loc?.url ?? landingUrl;
  if (!best) {
    // is_oa=true but no fetchable location — treat as closed rather than
    // sending the enricher after a null.
    return { status: 'closed' };
  }

  return {
    status: 'oa',
    location: {
      url: best,
      pdfUrl,
      landingUrl,
      hostType: loc?.host_type ?? null,
      version: loc?.version ?? null,
      license: loc?.license ?? null,
    },
  };
}

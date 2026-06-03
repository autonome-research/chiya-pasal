/**
 * URL normalization for dedup hashing.
 *
 * Goal: two URLs that point to the same paper hash to the same value.
 * Specifically:
 *   - arxiv version suffixes (v1/v2/...) collapse to bare id
 *   - osf API preprint URLs become human-readable https://osf.io/<slug>
 *   - osf preprint version suffixes (_v1/_v2/...) collapse to bare slug
 *   - bare DOIs (no scheme) → https://doi.org/<doi>
 *   - trailing slashes stripped
 *   - lowercased scheme + host
 *   - empty / whitespace → null (caller decides what to do)
 *
 * Conservative: doesn't follow redirects, doesn't strip query strings, doesn't
 * try to canonicalize wholly different domains for the same paper. URL hash is
 * for cheap dup-detection, not for citation-grade canonicalization.
 */

// Modern: 2602.20643[v\d+]   Old-style: cs.AI/0102003[v\d+] (category may have dot)
const ARXIV_RE = /^(?:https?:\/\/)?(?:www\.|export\.|api\.)?arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]+|[a-z\-]+(?:\.[A-Z]+)?\/[0-9]+)(?:v\d+)?(?:\.pdf)?\/?$/i;
const OSF_VERSION_RE = /(_v\d+)\/?$/;
const OSF_API_PREPRINT_RE = /^\/v2\/preprints\/([^/?#]+)\/?$/i;
// Bare DOI: starts with `10.<digits>/...` and no scheme.
const BARE_DOI_RE = /^10\.\d{4,9}\/.+/;

export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;

  // Bare DOI → doi.org
  if (BARE_DOI_RE.test(url)) {
    return `https://doi.org/${url}`;
  }

  // arxiv: collapse version suffix
  const arxivMatch = ARXIV_RE.exec(url);
  if (arxivMatch) {
    return `https://arxiv.org/abs/${arxivMatch[1]}`;
  }

  // Try URL parsing for everything else
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // unparseable; return as-is so it still hashes deterministically
  }

  // Lowercase scheme + host
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  if (parsed.hostname === 'api.osf.io') {
    const match = OSF_API_PREPRINT_RE.exec(parsed.pathname);
    const slug = match?.[1]?.replace(/_v\d+$/i, '');
    if (slug) return `https://osf.io/${slug}`;
  }

  // Strip osf version suffix from pathname
  parsed.pathname = parsed.pathname.replace(OSF_VERSION_RE, '/');

  // Strip trailing slash on pathname (but keep root /)
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}

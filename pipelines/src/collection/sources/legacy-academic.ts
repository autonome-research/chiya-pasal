import {
  makeReport,
  normalizeCandidate,
  type ArticleCandidate,
  type SourceAdapter,
  type SourceContext,
  type SourceRunResult,
} from '../source-adapter.js';
import { fetchJson, healthWarnings } from '../fetch.js';

export interface QuerySourceConfig {
  query: string;
  maxResults?: number;
  field?: string;
}

type Parser = (data: unknown, fallbackField?: string) => ArticleCandidate[];

function clampMax(n: number | undefined, cap = 50, fallback = 10): number {
  return Math.max(1, Math.min(cap, Number(n ?? fallback) || fallback));
}

async function fetchJsonSource(
  adapterName: string,
  displayName: string,
  url: string,
  parser: Parser,
  config: QuerySourceConfig,
  ctx: SourceContext,
): Promise<SourceRunResult> {
  const fetched = await fetchJson<unknown>({ source: adapterName, url, ctx });
  if (!fetched.ok) return { candidates: [], report: fetched.report };
  const candidates = parser(fetched.value, config.field);
  return {
    candidates,
    report: makeReport(adapterName, {
      fetched: candidates.length,
      emitted: candidates.length,
      warnings: [
        ...(displayName === adapterName ? [] : [`source=${displayName}`]),
        ...healthWarnings(fetched.attempts, fetched.elapsedMs),
      ],
    }),
  };
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const d = new Date(value.length === 4 ? `${value}-01-01T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function doiUrl(doi: unknown): string | undefined {
  const d = text(doi)?.replace(/^https?:\/\/doi\.org\//i, '');
  return d ? `https://doi.org/${d}` : undefined;
}

export const zenodoSource: SourceAdapter<QuerySourceConfig> = {
  name: 'zenodo',
  fetch(config, ctx) {
    return fetchJsonSource('zenodo', 'Zenodo', buildZenodoUrl(config), parseZenodo, config, ctx);
  },
};

export function buildZenodoUrl(config: QuerySourceConfig): string {
  const params = new URLSearchParams({ q: config.query, size: String(clampMax(config.maxResults)) });
  return `https://zenodo.org/api/records?${params.toString()}`;
}

export function parseZenodo(data: unknown, fallbackField = 'Research'): ArticleCandidate[] {
  const hits = (data as { hits?: { hits?: unknown[] } })?.hits?.hits ?? [];
  return hits.flatMap((item): ArticleCandidate[] => {
    const rec = item as Record<string, unknown>;
    const meta = (rec.metadata ?? {}) as Record<string, unknown>;
    const title = text(meta.title);
    const id = rec.id === undefined || rec.id === null ? undefined : String(rec.id);
    const doi = text(meta.doi);
    const url = doiUrl(doi) ?? text((rec.links as Record<string, unknown> | undefined)?.html) ?? (id ? `https://zenodo.org/records/${id}` : undefined);
    if (!title || !url) return [];
    const creators = Array.isArray(meta.creators) ? meta.creators : [];
    return [normalizeCandidate({
      title,
      url,
      source: 'Zenodo',
      field: text(meta.upload_type) ?? fallbackField,
      abstract: text(meta.description),
      publishedAt: parseDate(meta.publication_date),
      authors: creators.map((c) => text((c as Record<string, unknown>).name) ?? '').filter(Boolean),
      doi,
    })];
  });
}

export const doajSource: SourceAdapter<QuerySourceConfig> = {
  name: 'doaj',
  fetch(config, ctx) {
    return fetchJsonSource('doaj', 'DOAJ', buildDoajUrl(config), parseDoaj, config, ctx);
  },
};

export function buildDoajUrl(config: QuerySourceConfig): string {
  const params = new URLSearchParams({ q: config.query, size: String(clampMax(config.maxResults)) });
  return `https://doaj.org/api/search/articles/bibliographic?${params.toString()}`;
}

export function parseDoaj(data: unknown, fallbackField = 'Open Access'): ArticleCandidate[] {
  const results = (data as { results?: unknown[] })?.results ?? [];
  return results.flatMap((item): ArticleCandidate[] => {
    const bib = ((item as Record<string, unknown>).bibjson ?? {}) as Record<string, unknown>;
    const title = text(bib.title);
    const links = Array.isArray(bib.link) ? bib.link as Array<Record<string, unknown>> : [];
    const identifiers = Array.isArray(bib.identifier) ? bib.identifier as Array<Record<string, unknown>> : [];
    const doi = identifiers.map((i) => text(i.id)).find((id) => id?.startsWith('10.'));
    const url = links.map((l) => text(l.url)).find(Boolean) ?? doiUrl(doi);
    if (!title || !url) return [];
    return [normalizeCandidate({
      title,
      url,
      source: 'DOAJ',
      field: fallbackField,
      abstract: text(bib.abstract),
      publishedAt: parseDate(bib.year),
      doi,
    })];
  });
}

export const europePmcSource: SourceAdapter<QuerySourceConfig> = {
  name: 'europe-pmc',
  fetch(config, ctx) {
    return fetchJsonSource('europe-pmc', 'Europe PMC', buildEuropePmcUrl(config), parseEuropePmc, config, ctx);
  },
};

export function buildEuropePmcUrl(config: QuerySourceConfig): string {
  const params = new URLSearchParams({ query: config.query, format: 'json', resultType: 'core', pageSize: String(clampMax(config.maxResults, 20)) });
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`;
}

export function parseEuropePmc(data: unknown, fallbackField = 'Biomedical'): ArticleCandidate[] {
  const results = (data as { resultList?: { result?: unknown[] } })?.resultList?.result ?? [];
  return results.flatMap((item): ArticleCandidate[] => {
    const rec = item as Record<string, unknown>;
    const title = text(rec.title);
    const pmcid = text(rec.pmcid) ?? text(rec.pmc);
    const doi = text(rec.doi);
    const url = pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : doiUrl(doi) ?? text(rec.fullTextUrlList);
    if (!title || !url) return [];
    return [normalizeCandidate({
      title,
      url,
      source: 'Europe PMC',
      field: fallbackField,
      abstract: text(rec.abstractText),
      publishedAt: parseDate(rec.firstPublicationDate) ?? parseDate(rec.publishDate),
      doi,
      metadata: { citations: Number(rec.citedByCount ?? rec.pmcRefCount ?? 0) || 0 },
    })];
  });
}

export const inspireHepSource: SourceAdapter<QuerySourceConfig> = {
  name: 'inspire-hep',
  fetch(config, ctx) {
    return fetchJsonSource('inspire-hep', 'INSPIRE-HEP', buildInspireHepUrl(config), parseInspireHep, config, ctx);
  },
};

export function buildInspireHepUrl(config: QuerySourceConfig): string {
  const params = new URLSearchParams({ q: config.query, size: String(clampMax(config.maxResults)) });
  return `https://inspirehep.net/api/literature?${params.toString()}`;
}

export function parseInspireHep(data: unknown, fallbackField = 'Physics'): ArticleCandidate[] {
  const hits = (data as { hits?: { hits?: unknown[] } })?.hits?.hits ?? [];
  return hits.flatMap((item): ArticleCandidate[] => {
    const rec = item as Record<string, unknown>;
    const meta = (rec.metadata ?? {}) as Record<string, unknown>;
    const titleValue = Array.isArray(meta.titles) ? (meta.titles[0] as Record<string, unknown> | undefined)?.title : undefined;
    const id = rec.id === undefined || rec.id === null ? undefined : String(rec.id);
    const title = text(titleValue) ?? text(meta.title) ?? (id ? `INSPIRE Record #${id}` : undefined);
    const doi = Array.isArray(meta.dois) ? text((meta.dois[0] as Record<string, unknown> | undefined)?.value) : undefined;
    const url = id ? `https://inspirehep.net/literature/${id}` : doiUrl(doi);
    if (!title || !url) return [];
    const abstracts = Array.isArray(meta.abstracts) ? meta.abstracts : [];
    return [normalizeCandidate({
      title,
      url,
      source: 'INSPIRE-HEP',
      field: fallbackField,
      abstract: text((abstracts[0] as Record<string, unknown> | undefined)?.value),
      publishedAt: parseDate(text(meta.earliest_date)),
      doi,
      metadata: { citations: Number(meta.citation_count ?? 0) || 0 },
    })];
  });
}

export const ncbiSource: SourceAdapter<QuerySourceConfig> = {
  name: 'ncbi',
  async fetch(config, ctx) {
    const searchFetched = await fetchJson<{ esearchresult?: { idlist?: string[] } }>({ source: 'ncbi', url: buildNcbiSearchUrl(config), ctx });
    if (!searchFetched.ok) return { candidates: [], report: searchFetched.report };
    const ids = (searchFetched.value.esearchresult?.idlist ?? []).slice(0, clampMax(config.maxResults));
    if (ids.length === 0) {
      return { candidates: [], report: makeReport('ncbi', { warnings: healthWarnings(searchFetched.attempts, searchFetched.elapsedMs) }) };
    }
    const summaryFetched = await fetchJson<unknown>({ source: 'ncbi', url: buildNcbiSummaryUrl(ids), ctx });
    if (!summaryFetched.ok) return { candidates: [], report: makeReport('ncbi', { fetched: ids.length, warnings: [`summary failed`, ...summaryFetched.report.warnings] }) };
    const candidates = parseNcbiSummary(summaryFetched.value, config.field);
    return { candidates, report: makeReport('ncbi', { fetched: ids.length, emitted: candidates.length, warnings: [...healthWarnings(searchFetched.attempts + summaryFetched.attempts - 1, searchFetched.elapsedMs + summaryFetched.elapsedMs)] }) };
  },
};

export function buildNcbiSearchUrl(config: QuerySourceConfig): string {
  const params = new URLSearchParams({ db: 'pubmed', term: config.query, retmax: String(clampMax(config.maxResults)), retmode: 'json' });
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params.toString()}`;
}

function buildNcbiSummaryUrl(ids: string[]): string {
  const params = new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'json' });
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params.toString()}`;
}

export function parseNcbiSummary(data: unknown, fallbackField = 'Biomedical'): ArticleCandidate[] {
  const result = ((data as { result?: Record<string, unknown> }).result ?? {}) as Record<string, unknown>;
  const uids = Array.isArray(result.uids) ? result.uids.map(String) : Object.keys(result).filter((k) => k !== 'uids');
  return uids.flatMap((id): ArticleCandidate[] => {
    const rec = result[id] as Record<string, unknown> | undefined;
    const title = text(rec?.title);
    if (!title) return [];
    return [normalizeCandidate({
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      source: 'NCBI',
      field: fallbackField,
      publishedAt: parseDate(rec?.pubdate),
      authors: Array.isArray(rec?.authors) ? rec.authors.map((a) => text((a as Record<string, unknown>).name) ?? '').filter(Boolean) : undefined,
    })];
  });
}

export const osfSource: SourceAdapter<QuerySourceConfig> = {
  name: 'osf',
  fetch(config, ctx) {
    return fetchJsonSource('osf', 'OSF', buildOsfUrl(config), parseOsf, config, ctx);
  },
};

export function buildOsfUrl(config: QuerySourceConfig): string {
  const params = new URLSearchParams({ filter: config.query, 'page[size]': String(clampMax(config.maxResults)) });
  return `https://api.osf.io/v2/preprints/?${params.toString()}`;
}

export function parseOsf(data: unknown, fallbackField = 'Preprint'): ArticleCandidate[] {
  const items = (data as { data?: unknown[] })?.data ?? [];
  return items.flatMap((item): ArticleCandidate[] => {
    const rec = item as Record<string, unknown>;
    const attrs = (rec.attributes ?? {}) as Record<string, unknown>;
    const title = text(attrs.title) ?? text(attrs.name);
    const links = (rec.links ?? {}) as Record<string, unknown>;
    const url = osfHumanUrl(links, attrs);
    if (!title || !url) return [];
    return [normalizeCandidate({
      title,
      url,
      source: 'OSF',
      field: fallbackField,
      abstract: text(attrs.description),
      publishedAt: parseDate(attrs.date_published) ?? parseDate(attrs.date_created),
    })];
  });
}

function osfHumanUrl(links: Record<string, unknown>, attrs: Record<string, unknown>): string | undefined {
  const direct = text(links.iri) ?? text(links.html) ?? text(attrs.url);
  if (direct && !direct.includes('api.osf.io')) return direct;

  const apiUrl = text(links.self) ?? direct;
  if (!apiUrl) return direct;
  try {
    const u = new URL(apiUrl);
    const match = /^\/v2\/preprints\/([^/?#]+)\/?$/i.exec(u.pathname);
    const slug = match?.[1]?.replace(/_v\d+$/i, '');
    return slug ? `https://osf.io/${slug}` : direct;
  } catch {
    return direct;
  }
}

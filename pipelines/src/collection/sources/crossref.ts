import {
  makeReport,
  normalizeCandidate,
  type ArticleCandidate,
  type SourceAdapter,
  type SourceContext,
  type SourceRunResult,
} from '../source-adapter.js';
import { fetchJson, healthWarnings } from '../fetch.js';

export interface CrossrefSourceConfig {
  query: string;
  maxResults?: number;
  field?: string;
}

export const crossrefSource: SourceAdapter<CrossrefSourceConfig> = {
  name: 'crossref',
  async fetch(config: CrossrefSourceConfig, ctx: SourceContext): Promise<SourceRunResult> {
    const fetched = await fetchJson<CrossrefResponse>({ source: 'crossref', url: buildCrossrefUrl(config), ctx });
    if (!fetched.ok) return { candidates: [], report: fetched.report };
    const data = fetched.value;
    const candidates = parseCrossref(data, config.field);
    return { candidates, report: makeReport('crossref', { fetched: data.message?.items?.length ?? 0, emitted: candidates.length, warnings: healthWarnings(fetched.attempts, fetched.elapsedMs) }) };
  },
};

export function buildCrossrefUrl(config: CrossrefSourceConfig): string {
  const params = new URLSearchParams({
    query: config.query,
    rows: String(config.maxResults ?? 10),
    sort: 'is-referenced-by-count',
    order: 'desc',
  });
  return `https://api.crossref.org/works?${params.toString()}`;
}

interface CrossrefResponse {
  message?: {
    items?: Array<{
      title?: string[];
      DOI?: string;
      URL?: string;
      abstract?: string;
      subject?: string[];
      author?: Array<{ given?: string; family?: string }>;
      issued?: { 'date-parts'?: number[][] };
      'is-referenced-by-count'?: number;
    }>;
  };
}

export function parseCrossref(data: CrossrefResponse, fallbackField = 'Research'): ArticleCandidate[] {
  const out: ArticleCandidate[] = [];
  for (const item of data.message?.items ?? []) {
    const title = item.title?.[0]?.trim();
    const doi = item.DOI;
    const url = item.URL || (doi ? `https://doi.org/${doi}` : undefined);
    if (!title || !url) continue;
    out.push(normalizeCandidate({
      title,
      url,
      source: 'Crossref',
      field: item.subject?.[0] ?? fallbackField,
      abstract: stripTags(item.abstract ?? ''),
      publishedAt: dateFromParts(item.issued?.['date-parts']?.[0]),
      authors: item.author?.map((a) => `${a.given ?? ''} ${a.family ?? ''}`.trim()).filter(Boolean),
      doi,
      metadata: { citations: item['is-referenced-by-count'] ?? 0 },
    }));
  }
  return out;
}

function dateFromParts(parts?: number[]): Date | undefined {
  if (!parts?.[0]) return undefined;
  return new Date(Date.UTC(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1));
}

function stripTags(s: string): string | undefined {
  const stripped = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped || undefined;
}

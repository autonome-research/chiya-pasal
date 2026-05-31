import {
  makeReport,
  normalizeCandidate,
  type ArticleCandidate,
  type SourceAdapter,
  type SourceContext,
  type SourceRunResult,
} from '../source-adapter.js';

export interface SemanticScholarSourceConfig {
  query: string;
  maxResults?: number;
  field?: string;
}

export const semanticScholarSource: SourceAdapter<SemanticScholarSourceConfig> = {
  name: 'semantic-scholar',
  async fetch(config: SemanticScholarSourceConfig, ctx: SourceContext): Promise<SourceRunResult> {
    const fetchImpl = ctx.fetch ?? globalThis.fetch;
    const res = await fetchImpl(buildSemanticScholarUrl(config), { signal: ctx.signal, headers: { 'user-agent': 'chiya-collector/0.1' } });
    if (!res.ok) return { candidates: [], report: makeReport('semantic-scholar', { warnings: [`http ${res.status}`] }) };
    const data = await res.json() as SemanticScholarResponse;
    const candidates = parseSemanticScholar(data, config.field);
    return { candidates, report: makeReport('semantic-scholar', { fetched: data.data?.length ?? 0, emitted: candidates.length }) };
  },
};

export function buildSemanticScholarUrl(config: SemanticScholarSourceConfig): string {
  const params = new URLSearchParams({
    query: config.query,
    limit: String(config.maxResults ?? 10),
    fields: 'title,url,abstract,year,fieldsOfStudy,citationCount,authors,externalIds',
  });
  return `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`;
}

interface SemanticScholarResponse {
  data?: Array<{
    title?: string;
    url?: string;
    abstract?: string;
    year?: number;
    fieldsOfStudy?: string[];
    citationCount?: number;
    authors?: Array<{ name?: string }>;
    externalIds?: { DOI?: string; ArXiv?: string };
  }>;
}

export function parseSemanticScholar(data: SemanticScholarResponse, fallbackField = 'Research'): ArticleCandidate[] {
  const out: ArticleCandidate[] = [];
  for (const paper of data.data ?? []) {
    const title = paper.title?.trim();
    const url = paper.url || (paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : undefined);
    if (!title || !url) continue;
    out.push(normalizeCandidate({
      title,
      url,
      source: 'Semantic Scholar',
      field: paper.fieldsOfStudy?.[0] ?? fallbackField,
      abstract: paper.abstract,
      publishedAt: paper.year ? new Date(Date.UTC(paper.year, 0, 1)) : undefined,
      authors: paper.authors?.map((a) => a.name ?? '').filter(Boolean),
      doi: paper.externalIds?.DOI,
      arxivId: paper.externalIds?.ArXiv,
      metadata: { citations: paper.citationCount ?? 0 },
    }));
  }
  return out;
}

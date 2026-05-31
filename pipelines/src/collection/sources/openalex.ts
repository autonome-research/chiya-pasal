import {
  makeReport,
  normalizeCandidate,
  type ArticleCandidate,
  type SourceAdapter,
  type SourceContext,
  type SourceRunResult,
} from '../source-adapter.js';

export interface OpenAlexSourceConfig {
  query: string;
  maxResults?: number;
  field?: string;
}

export const openAlexSource: SourceAdapter<OpenAlexSourceConfig> = {
  name: 'openalex',
  async fetch(config: OpenAlexSourceConfig, ctx: SourceContext): Promise<SourceRunResult> {
    const fetchImpl = ctx.fetch ?? globalThis.fetch;
    const url = buildOpenAlexUrl(config);
    const res = await fetchImpl(url, { signal: ctx.signal, headers: { 'user-agent': 'chiya-collector/0.1' } });
    if (!res.ok) return { candidates: [], report: makeReport('openalex', { warnings: [`http ${res.status}`] }) };
    const data = await res.json() as OpenAlexResponse;
    const candidates = parseOpenAlex(data, config.field);
    return { candidates, report: makeReport('openalex', { fetched: data.results?.length ?? 0, emitted: candidates.length }) };
  },
};

export function buildOpenAlexUrl(config: OpenAlexSourceConfig): string {
  const params = new URLSearchParams({
    search: config.query,
    'per-page': String(config.maxResults ?? 10),
    sort: 'cited_by_count:desc',
  });
  return `https://api.openalex.org/works?${params.toString()}`;
}

interface OpenAlexResponse {
  results?: Array<{
    title?: string;
    doi?: string;
    publication_date?: string;
    cited_by_count?: number;
    open_access?: { oa_url?: string | null };
    primary_location?: { landing_page_url?: string | null };
    abstract_inverted_index?: Record<string, number[]> | null;
    topics?: Array<{ display_name?: string }>;
    authorships?: Array<{ author?: { display_name?: string } }>;
  }>;
}

export function parseOpenAlex(data: OpenAlexResponse, fallbackField = 'Research'): ArticleCandidate[] {
  const out: ArticleCandidate[] = [];
  for (const work of data.results ?? []) {
    const title = work.title?.trim();
    const url = work.open_access?.oa_url || work.primary_location?.landing_page_url || work.doi;
    if (!title || !url) continue;
    const abstract = abstractFromInvertedIndex(work.abstract_inverted_index ?? undefined);
    out.push(normalizeCandidate({
      title,
      url,
      source: 'OpenAlex',
      field: work.topics?.[0]?.display_name ?? fallbackField,
      abstract,
      publishedAt: work.publication_date ? new Date(work.publication_date) : undefined,
      authors: work.authorships?.map((a) => a.author?.display_name ?? '').filter(Boolean),
      doi: work.doi?.replace(/^https?:\/\/doi\.org\//i, ''),
      metadata: { citations: work.cited_by_count ?? 0 },
    }));
  }
  return out;
}

function abstractFromInvertedIndex(index?: Record<string, number[]>): string | undefined {
  if (!index) return undefined;
  const words: Array<{ word: string; pos: number }> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words.push({ word, pos });
  }
  words.sort((a, b) => a.pos - b.pos);
  return words.map((w) => w.word).join(' ') || undefined;
}

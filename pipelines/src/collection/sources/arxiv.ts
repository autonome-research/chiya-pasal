/** arXiv Atom API source adapter scaffold. */

import {
  makeReport,
  normalizeCandidate,
  type ArticleCandidate,
  type SourceAdapter,
  type SourceContext,
  type SourceRunResult,
} from '../source-adapter.js';
import { fetchText, healthWarnings } from '../fetch.js';

export interface ArxivSourceConfig {
  /** arXiv search query, e.g. `cat:cs.AI OR cat:cs.LG`. */
  query: string;
  maxResults?: number;
  sortBy?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
  sortOrder?: 'ascending' | 'descending';
  field?: string;
}

const DEFAULT_MAX_RESULTS = 25;

export const arxivSource: SourceAdapter<ArxivSourceConfig> = {
  name: 'arxiv',
  async fetch(config: ArxivSourceConfig, ctx: SourceContext): Promise<SourceRunResult> {
    const fetched = await fetchText({ source: 'arxiv', url: buildArxivApiUrl(config), ctx });
    if (!fetched.ok) return { candidates: [], report: fetched.report };

    const xml = fetched.value;
    const candidates = parseArxivAtom(xml, config.field);
    return {
      candidates,
      report: makeReport('arxiv', {
        fetched: candidates.length,
        emitted: candidates.length,
        dropped: 0,
        warnings: healthWarnings(fetched.attempts, fetched.elapsedMs),
      }),
    };
  },
};

export function buildArxivApiUrl(config: ArxivSourceConfig): string {
  const params = new URLSearchParams({
    search_query: config.query,
    start: '0',
    max_results: String(config.maxResults ?? DEFAULT_MAX_RESULTS),
    sortBy: config.sortBy ?? 'submittedDate',
    sortOrder: config.sortOrder ?? 'descending',
  });
  return `https://export.arxiv.org/api/query?${params.toString()}`;
}

export function parseArxivAtom(xml: string, field = 'AI/ML'): ArticleCandidate[] {
  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1] ?? '');
  const out: ArticleCandidate[] = [];

  for (const entry of entries) {
    const title = normalizeWhitespace(decodeXml(textOf(entry, 'title')));
    const summary = normalizeWhitespace(decodeXml(textOf(entry, 'summary')));
    const id = decodeXml(textOf(entry, 'id')).trim();
    const publishedRaw = decodeXml(textOf(entry, 'published')).trim();
    const doi = decodeXml(textOf(entry, 'arxiv:doi')).trim() || undefined;
    const authors = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((m) => normalizeWhitespace(decodeXml(m[1] ?? '')))
      .filter(Boolean);
    const arxivId = arxivIdFromUrl(id);

    if (!title || !id) continue;
    out.push(normalizeCandidate({
      title,
      url: id,
      source: 'arXiv',
      field,
      abstract: summary || undefined,
      publishedAt: publishedRaw ? new Date(publishedRaw) : undefined,
      authors,
      doi,
      arxivId,
      metadata: { adapter: 'arxiv' },
    }));
  }

  return out;
}

function textOf(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  return re.exec(xml)?.[1] ?? '';
}

function arxivIdFromUrl(url: string): string | undefined {
  const m = /arxiv\.org\/abs\/([^/?#]+)/i.exec(url);
  return m?.[1]?.replace(/v\d+$/i, '');
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

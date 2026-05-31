import type { ArticleCandidate, SourceRunReport } from './source-adapter.js';

export interface ApiArticleJson {
  title: string;
  abstract: string;
  url: string;
  source: string;
  domain: string;
  citations: number;
  year: string;
  abstract_short: string;
}

export function toApiArticleJson(candidate: ArticleCandidate): ApiArticleJson {
  const citations = typeof candidate.metadata?.citations === 'number' ? candidate.metadata.citations : 0;
  return {
    title: candidate.title,
    abstract: candidate.abstract ?? '',
    url: candidate.url,
    source: candidate.source,
    domain: candidate.field ?? 'Research',
    citations,
    year: candidate.publishedAt ? String(candidate.publishedAt.getUTCFullYear()) : '',
    abstract_short: (candidate.abstract ?? '').slice(0, 100),
  };
}

export function renderJsonl(candidates: ArticleCandidate[]): string {
  return candidates.map((c) => JSON.stringify(toApiArticleJson(c))).join('\n') + (candidates.length ? '\n' : '');
}

export function renderDigest(candidates: ArticleCandidate[], reports: SourceRunReport[], now = new Date()): string {
  const lines: string[] = [
    `# API Digest — ${now.toISOString().slice(0, 10)}`,
    '',
    '## Source health',
    '',
  ];
  for (const r of reports) {
    lines.push(`- ${r.source}: fetched=${r.fetched} emitted=${r.emitted} dropped=${r.dropped}${r.warnings.length ? ` warnings=${r.warnings.join('; ')}` : ''}`);
  }
  lines.push('', '## Articles', '');
  for (const c of candidates) {
    lines.push(`- [${c.title}](${c.url}) *(${c.source})*${c.abstract ? ` — ${c.abstract.slice(0, 400)}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * TypeScript source-synthesis extension surface.
 *
 * This is a scaffold for gradually moving matcha's Python API ingestion into
 * TypeScript without changing the live collector yet. Source adapters emit a
 * common ArticleCandidate shape; a later orchestrator can normalize, dedup,
 * score, and render the existing Markdown-first raw inbox artifact.
 */

export interface ArticleCandidate {
  title: string;
  url: string;
  source: string;
  /** Broad source/domain tag; not trusted as final wiki topic. */
  field?: string;
  abstract?: string;
  publishedAt?: Date;
  authors?: string[];
  doi?: string;
  arxivId?: string;
  /** Adapter-specific quality/provenance metadata. */
  metadata?: Record<string, unknown>;
}

export interface SourceContext {
  now: Date;
  interests: Record<string, string[]>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface SourceRunReport {
  source: string;
  fetched: number;
  emitted: number;
  dropped: number;
  warnings: string[];
}

export interface SourceRunResult {
  candidates: ArticleCandidate[];
  report: SourceRunReport;
}

export interface SourceAdapter<TConfig = unknown> {
  readonly name: string;
  fetch(config: TConfig, ctx: SourceContext): Promise<SourceRunResult>;
}

export function makeReport(source: string, partial: Partial<SourceRunReport> = {}): SourceRunReport {
  return {
    source,
    fetched: partial.fetched ?? 0,
    emitted: partial.emitted ?? 0,
    dropped: partial.dropped ?? 0,
    warnings: partial.warnings ?? [],
  };
}

export function isArticleCandidate(value: unknown): value is ArticleCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.title === 'string' && record.title.trim().length > 0 &&
    typeof record.url === 'string' && record.url.trim().length > 0 &&
    typeof record.source === 'string' && record.source.trim().length > 0;
}

export function normalizeCandidate(candidate: ArticleCandidate): ArticleCandidate {
  return {
    ...candidate,
    title: candidate.title.trim().replace(/\s+/g, ' '),
    url: candidate.url.trim(),
    source: candidate.source.trim(),
    field: candidate.field?.trim() || undefined,
    abstract: candidate.abstract?.trim() || undefined,
    authors: candidate.authors?.map((a) => a.trim()).filter(Boolean),
    doi: candidate.doi?.trim().toLowerCase() || undefined,
    arxivId: candidate.arxivId?.trim() || undefined,
  };
}

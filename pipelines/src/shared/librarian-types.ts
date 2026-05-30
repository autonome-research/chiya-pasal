/**
 * Types shared across the librarian phases.
 *
 * Sources are first-class wiki pages, topics are routing nodes. Each
 * article goes through router → 4 scouts (parallel) → reviewer →
 * deterministic write. See the phase composition in src/librarian.ts.
 */

import type { BasePipelineContext } from 'thread-phase';

import type { ArticleRow } from './article-store.js';

/** Per-article enriched body — full text fetched (or original snippet if no fetch was needed). */
export interface EnrichedArticle {
  articleId: number;
  /** What we use for downstream phases. May equal the original snippet if no fetch fired. */
  body: string;
  /** True iff we actually web_fetch'd; false if we kept the snippet as-is. */
  enriched: boolean;
  /** HTTP error or fetch skip-reason; only set when enriched=false and a fetch was attempted. */
  enrichError?: string;
}

/** Refs extracted from one article's enriched body. */
export interface ExtractedRefs {
  articleId: number;
  arxivIds: string[];
  dois: string[];
}

/** Per-article result of the fan-out tree — carries the page paths written
 *  (source page + topic page touches + cite backlinks). */
export interface ArticleResult {
  articleId: number;
  outcome: 'done' | 'skipped' | 'failed';
  reason?: string;
  /** wiki/sources/{stable-id}.md if the source page was written. */
  sourcePagePath?: string;
  /** wiki/topics/{slug}.md for each topic touched (created or updated). */
  topicPagePaths: string[];
  /** wiki/sources/{cited-id}.md for each cited source whose ## Cited by was bumped. */
  backlinkPagePaths: string[];
  /** Single line for log.md, no leading ##. */
  logEntry?: string;
}

export interface LibrarianCtx extends BasePipelineContext {
  readonly batchSize: number;
  readonly signal: AbortSignal;

  // Set by reapStale.
  reaped?: number;

  // Set by loadBatch.
  batch?: ArticleRow[];

  // Set by batchEnrich.
  enriched?: EnrichedArticle[];

  // Set by batchExtractRefs.
  refs?: ExtractedRefs[];

  // Set by the per-article fan-out (router → scouts → reviewer → write).
  results?: ArticleResult[];
}

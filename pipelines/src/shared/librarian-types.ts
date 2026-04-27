/**
 * Shared types for the librarian pipeline.
 */

import type { BasePipelineContext } from 'thread-phase';
import type { ArticleRow } from './article-store.js';

export interface ArticleResult {
  articleId: number;
  outcome: 'done' | 'skipped' | 'failed';
  reason?: string;
  pagePaths: string[];
  logEntry?: string;
  indexDeltas: string[];
}

export interface LibrarianCtx extends BasePipelineContext {
  /** Max articles to pull per run; cap on per-run wall time follows. */
  readonly batchSize: number;
  /** When set, the run started and processBatch is allowed to keep going for this long. */
  readonly deadlineAt: Date;

  reaped?: number;
  batch?: ArticleRow[];
  results?: ArticleResult[];
}

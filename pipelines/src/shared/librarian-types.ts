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
  /**
   * Soft-deadline cancellation signal. The entry point arms a setTimeout
   * that fires `controller.abort('deadline-reached')` after `--minutes`. The
   * signal is forwarded through processBatch into callTriage/callUpsert and
   * down into runAgentWithTools, so an in-flight LLM call can unwind cleanly
   * instead of running to natural completion past the deadline. Articles
   * whose runner observes the abort get rolled back to 'pending' for the
   * next run.
   */
  readonly signal: AbortSignal;

  reaped?: number;
  batch?: ArticleRow[];
  results?: ArticleResult[];
}

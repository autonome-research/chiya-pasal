/**
 * Types shared across the librarian phases.
 *
 * Sources are first-class wiki pages, topics are routing nodes. Each
 * article goes through router → 4 scouts (parallel) → reviewer →
 * deterministic write. See the phase composition in src/librarian.ts.
 *
 * The per-user librarian consumes rows the shared pipeline routed in:
 * the article's snippet IS its rich summary, and refs arrive pre-extracted
 * in columns. There is no per-user fetching or summarization.
 */

import type { BasePipelineContext } from 'thread-phase';

import type { ArticleRow } from './article-store.js';
import type { StableId } from '../phases/page-templates.js';
import type { ReviewerOutput } from '../phases/reviewer.js';

/** Refs for one article — from the shared router's columns, or a regex
 *  fallback over the body for rows that predate routing. Consumed by the
 *  librarian-router prompt and the cite-tracker scout. */
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

/** Semantic plan produced by the agentic per-article planner. It intentionally
 *  stores reviewer output rather than final gated topics/cites so the serial
 *  apply phase can revalidate against fresh vault state. */
export interface PlannedArticle {
  article: ArticleRow;
  stableId: StableId;
  sourceFilename: string;
  sourcePath: string;
  /** The article's rich summary (shared pipeline) or raw snippet (legacy
   *  rows) — whatever served as the scouts' body, destined for the source
   *  page. */
  summary: string;
  reviewer: ReviewerOutput;
}

export type ArticlePlanResult =
  | { articleId: number; outcome: 'planned'; plan: PlannedArticle }
  | { articleId: number; outcome: 'skipped'; reason: string; sourcePath?: string }
  | { articleId: number; outcome: 'failed'; reason: string }
  | { articleId: number; outcome: 'deferred'; reason: string };

export interface DryRunArticlePreview {
  articleId: number;
  outcome: 'would-write' | 'would-skip' | 'would-fail' | 'would-defer';
  reason?: string;
  sourcePagePath?: string;
  topicPagePaths: string[];
  backlinkPagePaths: string[];
  logEntry?: string;
}

export interface LibrarianCtx extends BasePipelineContext {
  readonly batchSize: number;
  readonly signal: AbortSignal;
  /** True when the run may call agents/read vault state but must not mutate the vault, git, or ArticleStore rows. */
  readonly dryRun?: boolean;

  // Set by reapStale.
  reaped?: number;

  // Set by loadBatch.
  batch?: ArticleRow[];

  // Set by the per-article planner (router → scouts → reviewer).
  articlePlans?: ArticlePlanResult[];

  // Set by the serial deterministic apply phase.
  results?: ArticleResult[];

  // Set by dry-run apply preview.
  dryRunPreviews?: DryRunArticlePreview[];
}

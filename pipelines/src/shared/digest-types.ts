/**
 * Shared types for the digest pipeline.
 */

import type { BasePipelineContext } from 'thread-phase';
import type { Article } from './article.js';

export type DigestDirection = 'AM' | 'PM';

export type Bucket = 'focus' | 'notable' | 'followup' | 'skip';

export interface VaultContext {
  claudeMd: string;
  tasteMd: string;
  indexMd: string;
  /** Tail of log.md — recent activity for the librarian-update section. */
  logTail: string;
  /** Each file in wiki/user/focuses/ — current high-priority interests. */
  focuses: Array<{ path: string; content: string }>;
  /** Each STATUS.md under wiki/research/<project>/ — active research. */
  research: Array<{ path: string; content: string }>;
  profile: string | null;
  interests: string | null;
}

export interface ClassifiedArticle {
  article: Article;
  bucket: Bucket;
  reason: string;
  /** Wiki page slugs this article extends (for the followup bucket). */
  wikilinks: string[];
}

export interface DigestSection {
  /** Markdown heading without the leading `## `. */
  heading: string;
  /** Final formatted markdown body (excluding the heading line). */
  body: string;
}

export interface DigestCtx extends BasePipelineContext {
  // Inputs (set by the entry point)
  readonly direction: DigestDirection;
  readonly date: string; // YYYY-MM-DD
  /** Entry-point cancellation signal, plumbed into digest LLM calls. */
  readonly signal: AbortSignal;

  // Phase outputs
  vault?: VaultContext;
  articlesPath?: string;
  articles?: Article[];
  classified?: ClassifiedArticle[];
  sections?: DigestSection[];
  digest?: string;
  /** Set after appendLog so commitDigest knows there's something to commit. */
  logEntry?: string;
  pushed?: { squashedCount: number; sha?: string; pushed: boolean };
  emailed?: { ok: boolean; output: string };
}

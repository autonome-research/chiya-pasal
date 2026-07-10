/**
 * Context for the shared pipeline (absorb → enrich → summarize → embed →
 * route). One ctx type for all phases, mirroring LibrarianCtx — phases
 * write summary counts here; row-level state lives in SharedArticleStore.
 */

import type { BasePipelineContext } from 'thread-phase';

export interface SharedPipelineCtx extends BasePipelineContext {
  readonly signal: AbortSignal;

  // Set by scan-shared-inbox.
  inboxFiles?: string[];

  // Set by absorb-inbox.
  absorbCounts?: { files: number; parsed: number; inserted: number; duplicates: number; skippedNoUrl: number };

  // Set by shared-enrich.
  enrichCounts?: { enriched: number; enrichFailed: number; retryLater: number };

  // Set by shared-summarize.
  summarizeCounts?: { summarized: number; failed: number; noText: number; rejected: number };

  // Set by shared-embed.
  embeddedCount?: number;

  // Set by shared-route.
  routeCounts?: { articles: number; matches: number; copied: number; duplicates: number };
}

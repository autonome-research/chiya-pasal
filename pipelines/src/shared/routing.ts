/**
 * Per-user routing — decide which users receive each article based on
 * cosine similarity between a user's interest embedding and the article's
 * summary embedding.
 *
 * Threshold tuning notes from real qwen3-embed-8b output on paragraph-length
 * inputs (verified 2026-06-28):
 *
 *   matching pairs:    0.60–0.70
 *   non-matching:      0.30–0.35
 *   bare keyword pairs: ~0.45 baseline regardless of meaning (don't use)
 *
 * So the routing inputs MUST be paragraph-length: user interest profile is a
 * descriptive paragraph, not a keyword list; article side is the rich summary
 * the shared-summarize phase produces. Default threshold is 0.50 — comfortably
 * inside the discrimination band, with per-user override possible.
 */

export interface RoutingUser {
  handle: string;
  /** Embedding of the user's interest profile paragraph. */
  interestVector: number[];
  /** Optional per-user override of the default threshold. */
  threshold?: number;
}

export interface RoutingArticle {
  stableId: string;
  /** Embedding of the article's rich summary. */
  summaryVector: number[];
}

export interface RoutingMatch {
  stableId: string;
  userHandle: string;
  similarity: number;
}

export interface RoutingOptions {
  /** Default threshold; users can override per-user. */
  threshold?: number;
  /** Hard cap on matches per article — protects against a viral article
   *  flooding every user. Default null (no cap). */
  maxUsersPerArticle?: number;
}

export const DEFAULT_THRESHOLD = 0.5;

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Returns 0 for any pair containing a zero-vector or mismatched lengths;
 * these are operational pathologies (a model returning zeros, or two
 * different models being mixed) and should not silently route articles
 * to wrong users.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * For each article, return all (user, similarity) pairs whose similarity
 * meets the user's threshold (or the default). Sorted within each article
 * by similarity descending; matches across articles are concatenated in
 * input order.
 *
 * O(articles × users × dim) — fine for the scales we expect (hundreds of
 * articles per cycle, single-digit users, dim=1536).
 */
export function routeArticles(
  articles: readonly RoutingArticle[],
  users: readonly RoutingUser[],
  options: RoutingOptions = {},
): RoutingMatch[] {
  const defaultThreshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxPerArticle = options.maxUsersPerArticle ?? null;

  const out: RoutingMatch[] = [];
  for (const article of articles) {
    const perArticle: RoutingMatch[] = [];
    for (const user of users) {
      const sim = cosine(article.summaryVector, user.interestVector);
      const threshold = user.threshold ?? defaultThreshold;
      if (sim >= threshold) {
        perArticle.push({
          stableId: article.stableId,
          userHandle: user.handle,
          similarity: sim,
        });
      }
    }
    perArticle.sort((a, b) => b.similarity - a.similarity);
    const capped = maxPerArticle !== null ? perArticle.slice(0, maxPerArticle) : perArticle;
    out.push(...capped);
  }
  return out;
}

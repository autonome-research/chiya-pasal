/**
 * Shared routing phases — two modes (selected in shared-pipeline.ts from
 * CHIYA_ROUTING_MODE):
 *
 * embedding mode (embedSummaries + routeEmbedded):
 *   - embedSummaries: batch-embed newly summarized articles ('summarized' →
 *     'embedded'). User interest paragraphs are embedded fresh in the
 *     routing phase — a handful of users × a few paragraphs is one cheap
 *     batch call; caching them would add invalidation complexity for no
 *     measurable win.
 *   - routeEmbedded: score every 'embedded' article against every enabled
 *     user (max-over-interest-vectors cosine), COPY matches into each
 *     user's per-user ArticleStore (self-contained per-user layer — the
 *     shared cache stays independently prunable), persist the full score
 *     matrix for threshold tuning, then mark articles 'routed'.
 *
 * broadcast mode (routeBroadcast):
 *   - every quality-passing article goes to every enabled user, straight
 *     from 'summarized' to 'routed' (no embeddings, no scores). The
 *     degraded-but-useful mode while the embedding service is down. No
 *     routing_log rows are written — the log measures embedding-admission
 *     quality, and broadcast decisions carry no signal worth tuning on.
 *
 * Both copy paths are idempotent (upsertRouted dedups by url/title), so a
 * crash mid-phase replays cleanly, and switching modes later requires no
 * migration: 'summarized' rows simply take whichever path is active.
 */

import type { Phase } from 'thread-phase';

import type { SharedPipelineCtx } from '../../shared/shared-pipeline-types.js';
import { embedBatch, type EmbeddingTarget } from '../../shared/embedding.js';
import {
  routeArticlesDetailed,
  type RoutingOptions,
  type RoutingUser,
} from '../../shared/routing.js';
import type { SharedArticleRow, SharedArticleStore } from '../../shared/shared-article-store.js';
import type { ArticleStore } from '../../shared/article-store.js';
import type { User } from '../../shared/users.js';

const EMBED_BATCH = 64;
const ROUTE_BATCH = 200;

/** Copy one shared-cache article into one user's store. Shared by both
 *  routing modes so provenance fields stay consistent. The quality
 *  assessment rides along: it is the only place the per-user layer can
 *  learn it, and the wiki's importance signals are projected from it. */
function copyToUser(
  userStore: ArticleStore,
  article: SharedArticleRow,
  similarity: number | null,
): 'inserted' | 'duplicate' {
  const r = userStore.upsertRouted({
    title: article.title,
    url: article.url,
    source: article.source,
    field: article.field,
    summary: article.summary ?? '',
    refsArxiv: article.refsArxiv,
    refsDoi: article.refsDoi,
    sharedStableId: article.stableId,
    routedSimilarity: similarity,
    qualityRigor: article.quality?.rigor ?? null,
    qualityEvidence: article.quality?.evidence ?? null,
    collectedAt: article.collectedAt,
  });
  return r.result === 'inserted' ? 'inserted' : 'duplicate';
}

export const embedSummaries = (
  store: SharedArticleStore,
  target: EmbeddingTarget,
  deps: { embed?: typeof embedBatch } = {},
): Phase<SharedPipelineCtx> => ({
  name: 'shared-embed',
  async *run(ctx) {
    const embed = deps.embed ?? embedBatch;
    const batch = store.listByStatus('summarized', EMBED_BATCH);
    if (batch.length === 0) {
      ctx.embeddedCount = 0;
      yield { type: 'phase', phase: 'shared-embed', detail: 'nothing to embed' };
      return;
    }

    const vectors = await embed(
      batch.map((a) => a.summary ?? ''),
      target,
      { signal: ctx.signal },
    );
    for (let i = 0; i < batch.length; i++) {
      store.markEmbedded(batch[i]!.stableId, vectors[i]!.vector);
    }

    ctx.embeddedCount = batch.length;
    yield {
      type: 'phase',
      phase: 'shared-embed',
      detail: `${batch.length} summaries embedded`,
      counts: { embedded: batch.length },
    };
  },
});

/** Opens (and caches) one per-user ArticleStore per handle for the phase run. */
export type UserStoreFactory = (handle: string) => ArticleStore;

export interface RouteDeps {
  embed?: typeof embedBatch;
  openUserStore: UserStoreFactory;
}

export const routeEmbedded = (
  store: SharedArticleStore,
  users: readonly User[],
  target: EmbeddingTarget,
  deps: RouteDeps,
  options: RoutingOptions = {},
): Phase<SharedPipelineCtx> => ({
  name: 'shared-route',
  async *run(ctx) {
    const embed = deps.embed ?? embedBatch;
    const batch = store.listByStatus('embedded', ROUTE_BATCH);
    if (batch.length === 0 || users.length === 0) {
      ctx.routeCounts = { articles: 0, matches: 0, copied: 0, duplicates: 0 };
      yield {
        type: 'phase',
        phase: 'shared-route',
        detail: batch.length === 0 ? 'nothing to route' : 'no enabled users',
      };
      return;
    }

    // Embed all users' interest paragraphs in one batch call, then slice
    // the flat result back into per-user vector lists.
    const paragraphs = users.flatMap((u) => u.interests);
    const flat = await embed(paragraphs, target, { signal: ctx.signal });
    const routingUsers: RoutingUser[] = [];
    let offset = 0;
    for (const u of users) {
      routingUsers.push({
        handle: u.handle,
        interestVectors: flat.slice(offset, offset + u.interests.length).map((r) => r.vector),
        threshold: u.threshold,
      });
      offset += u.interests.length;
    }

    const articles = batch.map((a) => ({
      stableId: a.stableId,
      summaryVector: a.summaryEmbedding ?? [],
    }));
    const { matches, scores } = routeArticlesDetailed(articles, routingUsers, options);

    // Copy matched articles into per-user stores.
    const byId = new Map<string, SharedArticleRow>(batch.map((a) => [a.stableId, a]));
    const stores = new Map<string, ArticleStore>();
    let copied = 0;
    let duplicates = 0;
    for (const m of matches) {
      const article = byId.get(m.stableId)!;
      let userStore = stores.get(m.userHandle);
      if (!userStore) {
        userStore = deps.openUserStore(m.userHandle);
        stores.set(m.userHandle, userStore);
      }
      if (copyToUser(userStore, article, m.similarity) === 'inserted') copied++;
      else duplicates++;
    }
    for (const s of stores.values()) s.close();

    store.logRoutingDecisions(scores);
    for (const a of batch) store.markRouted(a.stableId);

    ctx.routeCounts = { articles: batch.length, matches: matches.length, copied, duplicates };
    yield {
      type: 'phase',
      phase: 'shared-route',
      detail: `${batch.length} articles → ${matches.length} matches (${copied} copied, ${duplicates} dup)`,
      counts: ctx.routeCounts,
    };
  },
});

/**
 * Broadcast routing: every 'summarized' article is copied to EVERY enabled
 * user, then marked 'routed' (the 'embedded' stage is skipped entirely).
 * Used while the embedding service is down — see the module docstring.
 */
export const routeBroadcast = (
  store: SharedArticleStore,
  users: readonly User[],
  deps: { openUserStore: UserStoreFactory },
): Phase<SharedPipelineCtx> => ({
  name: 'shared-route-broadcast',
  async *run(ctx) {
    const batch = store.listByStatus('summarized', ROUTE_BATCH);
    if (batch.length === 0 || users.length === 0) {
      ctx.routeCounts = { articles: 0, matches: 0, copied: 0, duplicates: 0 };
      yield {
        type: 'phase',
        phase: 'shared-route-broadcast',
        detail: batch.length === 0 ? 'nothing to route' : 'no enabled users',
      };
      return;
    }

    const stores = new Map<string, ArticleStore>();
    let copied = 0;
    let duplicates = 0;
    try {
      for (const user of users) {
        let userStore = stores.get(user.handle);
        if (!userStore) {
          userStore = deps.openUserStore(user.handle);
          stores.set(user.handle, userStore);
        }
        for (const article of batch) {
          if (copyToUser(userStore, article, null) === 'inserted') copied++;
          else duplicates++;
        }
      }
    } finally {
      for (const s of stores.values()) s.close();
    }

    for (const a of batch) store.markRouted(a.stableId);

    ctx.routeCounts = {
      articles: batch.length,
      matches: batch.length * users.length,
      copied,
      duplicates,
    };
    yield {
      type: 'phase',
      phase: 'shared-route-broadcast',
      detail: `${batch.length} articles → ${users.length} user(s) (${copied} copied, ${duplicates} dup)`,
      counts: ctx.routeCounts,
    };
  },
});

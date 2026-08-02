/**
 * Librarian article planning phase.
 *
 * This phase does the expensive per-article agent work but performs no vault
 * writes and no ArticleStore status transitions. It returns semantic plans
 * that a later serial apply phase revalidates against fresh vault state before
 * mutating files/DB rows.
 *
 * The article's body IS its rich summary: the shared pipeline enriches,
 * summarizes, and routes articles into this store with the summary in the
 * snippet column and refs pre-extracted into columns. The per-user librarian
 * performs no fetching and no summarization — it curates. (Rows that arrived
 * outside the router — legacy backfills — degrade gracefully: their raw
 * snippet serves as the body, and refs fall back to a regex pass over it.)
 */

import { setMaxListeners } from 'events';
import { requireCtx, type Phase } from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';

import type { ArticleRow, ArticleStore } from '../shared/article-store.js';
import type { ArticlePlanResult, ExtractedRefs, LibrarianCtx } from '../shared/librarian-types.js';
import { extractArxivIds, extractDois } from '../shared/refs.js';
import {
  scanTopicRegistry,
  vocabularyForPrompt,
  type TopicRecord,
  type TopicRegistry,
} from '../shared/topic-registry.js';
import type { VaultFs } from '../tools/vault.js';
import { stableIdForUrl, stableIdToFilename } from './page-templates.js';
import { runRouter, type RouterRunner } from './librarian-router.js';
import { runTopicScout, type TopicScoutRunner } from './scouts/topic-scout.js';
import { runSourceScout, type SourceScoutRunner } from './scouts/source-scout.js';
import { runEntityScout, type EntityScoutRunner } from './scouts/entity-scout.js';
import { runCiteTracker, type CiteTrackerRunner } from './scouts/cite-tracker.js';
import {
  isReviewerFailureReason,
  REVIEWER_FAILURE_MAX_DEFERRALS,
  reviewerFailureAttempts,
  reviewerFailureReason,
  runReviewer,
  type ReviewerRunner,
} from './reviewer.js';

export interface PerArticleClients {
  /** Tool-capable model used by router + 4 scouts + reviewer. The librarian
   *  needs no other inference — summaries arrive pre-computed. */
  toolsClient: OpenAI;
  toolsModel: string;
}

/** Optional DI overrides for testing. All default to the real implementations. */
export interface PerArticleDeps {
  router?: RouterRunner;
  topicScout?: TopicScoutRunner;
  sourceScout?: SourceScoutRunner;
  entityScout?: EntityScoutRunner;
  citeTracker?: CiteTrackerRunner;
  reviewer?: ReviewerRunner;
  /** Run-level topic vocabulary source. Defaults to loadTopicRegistry(vault). */
  loadRegistry?: () => TopicRegistry | Promise<TopicRegistry>;
}

/** Vault-root artifact written by the registry emitter. */
export const REGISTRY_JSON_PATH = 'registry.json';

/** Char budgets for the injected vocabulary. The reviewer assigns against it,
 *  so it gets the larger share; the scout only needs enough to aim searches,
 *  and it runs four-wide per article. */
const REVIEWER_VOCABULARY_CHARS = 6000;
const SCOUT_VOCABULARY_CHARS = 2000;

const EMPTY_REGISTRY: TopicRegistry = { topics: [], clusters: {}, generatedAt: '' };

function recordFrom(raw: unknown): TopicRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== 'string' || o.slug.length === 0) return null;
  return {
    slug: o.slug,
    title: typeof o.title === 'string' ? o.title : o.slug,
    oneLiner: typeof o.oneLiner === 'string' ? o.oneLiner : null,
    clusters: Array.isArray(o.clusters) ? o.clusters.filter((c): c is string => typeof c === 'string') : [],
    memberCount: typeof o.memberCount === 'number' ? o.memberCount : 0,
    citedByTotal: typeof o.citedByTotal === 'number' ? o.citedByTotal : 0,
    updated: typeof o.updated === 'string' ? o.updated : null,
  };
}

/** Parse the emitted registry.json back into a TopicRegistry. Returns null on
 *  anything unexpected so the caller falls back to a live scan rather than
 *  feeding the agents a half-parsed vocabulary. */
export function parseRegistryJson(text: string): TopicRegistry | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const o = doc as Record<string, unknown>;
  if (!Array.isArray(o.topics)) return null;
  const topics: TopicRecord[] = [];
  for (const t of o.topics) {
    const rec = recordFrom(t);
    if (rec) topics.push(rec);
  }
  const clusters: Record<string, { topicCount: number }> = {};
  if (Array.isArray(o.clusters)) {
    for (const c of o.clusters) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      if (typeof co.name !== 'string') continue;
      clusters[co.name] = {
        topicCount: typeof co.topicCount === 'number' ? co.topicCount : 0,
      };
    }
  }
  return {
    topics,
    clusters,
    generatedAt: typeof o.generatedAt === 'string' ? o.generatedAt : '',
  };
}

/**
 * The run's topic vocabulary: the emitted registry.json when present, else a
 * live scan of wiki/topics. The emitted file is preferred because it is what
 * humans and the visualization tool see — but a vault that has never run the
 * emitter (every vault, today) must not leave the agents blind, and a scan of
 * the live 2.6k-page namespace costs ~130 ms.
 *
 * Read-only, once per run. The apply gate does NOT trust this snapshot: it
 * re-derives existing slugs from disk per article.
 */
export async function loadTopicRegistry(vault: VaultFs): Promise<TopicRegistry> {
  const generatedAt = new Date().toISOString();
  const emitted = await vault.readOptional(REGISTRY_JSON_PATH);
  if (emitted !== null) {
    const parsed = parseRegistryJson(emitted);
    if (parsed && parsed.topics.length > 0) return parsed;
  }
  return scanTopicRegistry(vault.rootDir, generatedAt);
}

/**
 * Refs for one article: the columns the shared router populated, falling
 * back to a regex pass over the body for rows that predate routing.
 */
export function refsForArticle(article: ArticleRow, body: string): ExtractedRefs {
  return {
    articleId: article.id,
    arxivIds: article.refsArxiv ?? extractArxivIds(body),
    dois: article.refsDoi ?? extractDois(body),
  };
}

const PER_ARTICLE_CONCURRENCY = 4;

/** Legacy summarize failures cemented '{"_error":true,...}' blobs into the
 *  snippet column. The shared summarize gate blocks new ones; this planner
 *  guard is defense in depth so such a payload is never planned from. */
const ERROR_BLOB_RE = /^\s*\{"_error"\s*:\s*true/;

export const planArticleTree =
  (
    clients: PerArticleClients,
    vault: VaultFs,
    store: ArticleStore,
    deps: PerArticleDeps = {},
  ): Phase<LibrarianCtx> => ({
    name: 'plan-article-tree',
    async *run(ctx) {
      const batch = requireCtx(ctx, 'batch', 'plan-article-tree');

      const router = deps.router ?? runRouter;
      const topicScout = deps.topicScout ?? runTopicScout;
      const sourceScout = deps.sourceScout ?? runSourceScout;
      const entityScout = deps.entityScout ?? runEntityScout;
      const citeTracker = deps.citeTracker ?? runCiteTracker;
      const reviewer = deps.reviewer ?? runReviewer;

      const toolsClients = { client: clients.toolsClient, model: clients.toolsModel };

      // One registry load per run, shared by every article's scout + reviewer.
      // A failure here degrades to blind planning (the pre-registry behavior)
      // rather than failing the batch.
      let registry: TopicRegistry;
      try {
        registry = await (deps.loadRegistry ?? (() => loadTopicRegistry(vault)))();
      } catch (err) {
        console.warn(
          `[plan] topic registry unavailable, planning without vocabulary: ${err instanceof Error ? err.message : err}`,
        );
        registry = EMPTY_REGISTRY;
      }
      const reviewerVocabulary = vocabularyForPrompt(registry, {
        maxChars: REVIEWER_VOCABULARY_CHARS,
      });
      const scoutVocabulary = vocabularyForPrompt(registry, { maxChars: SCOUT_VOCABULARY_CHARS });

      const fanoutResults = await boundedFanout({
        items: batch,
        concurrency: PER_ARTICLE_CONCURRENCY,
        mode: 'collect' as const,
        signal: ctx.signal,
        runner: async (article, _idx, parentSignal): Promise<ArticlePlanResult> => {
          const stableId = stableIdForUrl(article.url ?? '');
          if (!stableId) {
            return {
              articleId: article.id,
              outcome: 'skipped',
              reason: 'no-url-no-stable-id',
            };
          }

          const sourceFilename = stableIdToFilename(stableId);
          const sourcePath = `wiki/sources/${sourceFilename}.md`;
          if (await vault.exists(sourcePath)) {
            return {
              articleId: article.id,
              outcome: 'skipped',
              reason: 'already-ingested',
              sourcePath,
            };
          }

          // The rich summary from the shared pipeline (or, for legacy rows,
          // the raw collected snippet — degraded but workable scout context).
          // An empty body or an error blob is not prose to plan from: defer
          // until a usable summary exists rather than cementing garbage.
          const body = article.snippet ?? '';
          if (body.trim().length === 0 || ERROR_BLOB_RE.test(body)) {
            return {
              articleId: article.id,
              outcome: 'deferred',
              reason: 'summary-unavailable',
            };
          }

          // Per-article child AbortController. Each runner has multiple LLM
          // subcalls; using a child signal prevents listener buildup on the
          // parent while preserving cancellation from the deadline/systemd path.
          const childCtrl = new AbortController();
          setMaxListeners(50, childCtrl.signal);
          const onParentAbort = (): void => {
            childCtrl.abort(parentSignal?.reason);
          };
          if (parentSignal?.aborted) {
            childCtrl.abort(parentSignal.reason);
          } else if (parentSignal) {
            parentSignal.addEventListener('abort', onParentAbort, { once: true });
          }
          const signal = childCtrl.signal;
          const releaseParentListener = (): void => {
            if (parentSignal && !parentSignal.aborted) {
              parentSignal.removeEventListener('abort', onParentAbort);
            }
          };

          const articleRefs = refsForArticle(article, body);

          try {
            const routerOut = await router(
              { article, body, refs: articleRefs },
              toolsClients,
              signal,
            );

            const [topicOut, sourceOut, entityOut, citeOut] = await Promise.all([
              topicScout(
                { article, body, task: routerOut.topicScoutTask, vocabulary: scoutVocabulary },
                toolsClients,
                vault,
                signal,
              ),
              sourceScout(
                { article, body, task: routerOut.sourceScoutTask },
                toolsClients,
                vault,
                store,
                signal,
              ),
              entityScout(
                { article, body, task: routerOut.entityScoutTask },
                toolsClients,
                vault,
                signal,
              ),
              citeTracker(
                { article, body, refs: articleRefs, task: routerOut.citeTrackerTask },
                toolsClients,
                vault,
                store,
                signal,
              ),
            ]);

            const reviewerOut = await reviewer(
              {
                article,
                body,
                topicScout: topicOut,
                sourceScout: sourceOut,
                entityScout: entityOut,
                citeTracker: citeOut,
                vocabulary: reviewerVocabulary,
              },
              toolsClients,
              vault,
              signal,
            );

            // A reviewer failure carries no recommendations — filing now
            // would silently drop the article's topics/cites/related/entities.
            // Defer for retry until the attempt cap; the capped article falls
            // through to degraded uncategorized filing (apply logs it).
            if (reviewerOut.error) {
              const attempt = reviewerFailureAttempts(article.statusReason) + 1;
              if (attempt <= REVIEWER_FAILURE_MAX_DEFERRALS) {
                return {
                  articleId: article.id,
                  outcome: 'deferred',
                  reason: reviewerFailureReason(attempt, reviewerOut.error),
                };
              }
            }

            // The summary in the plan is the article's pre-computed rich
            // summary. Final topics/cites are deliberately NOT in the plan:
            // the apply phase re-gates reviewer output against fresh vault
            // state.
            return {
              articleId: article.id,
              outcome: 'planned',
              plan: {
                article,
                stableId,
                sourceFilename,
                sourcePath,
                summary: body,
                reviewer: reviewerOut,
              },
            };
          } finally {
            releaseParentListener();
          }
        },
      });

      ctx.articlePlans = fanoutResults.map((r, i): ArticlePlanResult => {
        if (r.ok) return r.value;
        const article = batch[i]!;
        if (r.error.name === 'AbortError') {
          return {
            articleId: article.id,
            outcome: 'deferred',
            reason: 'deadline-rolled-over',
          };
        }
        return {
          articleId: article.id,
          outcome: 'failed',
          reason: r.error.message.slice(0, 200),
        };
      });

      const tally = ctx.articlePlans.reduce(
        (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
        { planned: 0, skipped: 0, deferred: 0, failed: 0 } as Record<string, number>,
      );
      // Reviewer outages must be visible in the journal, not laundered.
      tally.reviewerDeferred = ctx.articlePlans.filter(
        (r) => r.outcome === 'deferred' && isReviewerFailureReason(r.reason),
      ).length;
      // A silently-empty vocabulary is the failure mode this phase exists to
      // prevent, so the size the agents actually saw is journalled.
      tally.vocabularyTopics = registry.topics.length;
      yield {
        type: 'phase',
        phase: 'plan-article-tree',
        detail: `planned=${tally.planned} skipped=${tally.skipped} deferred=${tally.deferred} failed=${tally.failed} reviewer-deferred=${tally.reviewerDeferred} vocab-topics=${tally.vocabularyTopics}`,
        counts: tally,
      };
    },
  });

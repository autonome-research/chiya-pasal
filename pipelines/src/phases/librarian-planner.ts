/**
 * Librarian article planning phase.
 *
 * This phase does the expensive per-article agent work but performs no vault
 * writes and no ArticleStore status transitions. It returns semantic plans
 * that a later serial apply phase revalidates against fresh vault state before
 * mutating files/DB rows.
 */

import { setMaxListeners } from 'events';
import { requireCtx, type Phase } from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';

import type { ArticleStore } from '../shared/article-store.js';
import type { ArticlePlanResult, LibrarianCtx } from '../shared/librarian-types.js';
import type { VaultFs } from '../tools/vault.js';
import { stableIdForUrl, stableIdToFilename } from './page-templates.js';
import { runRouter, type RouterRunner } from './librarian-router.js';
import { runTopicScout, type TopicScoutRunner } from './scouts/topic-scout.js';
import { runSourceScout, type SourceScoutRunner } from './scouts/source-scout.js';
import { runEntityScout, type EntityScoutRunner } from './scouts/entity-scout.js';
import { runCiteTracker, type CiteTrackerRunner } from './scouts/cite-tracker.js';
import { runReviewer, type ReviewerRunner } from './reviewer.js';
import { callSummary, type Summarizer } from './summary.js';

export interface PerArticleClients {
  /** Tool-capable model used by router + 4 scouts + reviewer. */
  toolsClient: OpenAI;
  toolsModel: string;
  /** Fast model for the per-article summary call. */
  summaryClient: OpenAI;
  summaryModel: string;
}

/** Optional DI overrides for testing. All default to the real implementations. */
export interface PerArticleDeps {
  router?: RouterRunner;
  topicScout?: TopicScoutRunner;
  sourceScout?: SourceScoutRunner;
  entityScout?: EntityScoutRunner;
  citeTracker?: CiteTrackerRunner;
  reviewer?: ReviewerRunner;
  summarizer?: Summarizer;
}

const PER_ARTICLE_CONCURRENCY = 4;

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
      const enriched = requireCtx(ctx, 'enriched', 'plan-article-tree');
      const refs = requireCtx(ctx, 'refs', 'plan-article-tree');

      const enrichedById = new Map(enriched.map((e) => [e.articleId, e]));
      const refsById = new Map(refs.map((r) => [r.articleId, r]));

      const router = deps.router ?? runRouter;
      const topicScout = deps.topicScout ?? runTopicScout;
      const sourceScout = deps.sourceScout ?? runSourceScout;
      const entityScout = deps.entityScout ?? runEntityScout;
      const citeTracker = deps.citeTracker ?? runCiteTracker;
      const reviewer = deps.reviewer ?? runReviewer;
      const summarizer = deps.summarizer ?? callSummary;

      const toolsClients = { client: clients.toolsClient, model: clients.toolsModel };

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

          const body = enrichedById.get(article.id)?.body ?? article.snippet ?? '';
          const articleRefs = refsById.get(article.id) ?? {
            articleId: article.id,
            arxivIds: [],
            dois: [],
          };

          try {
            const routerOut = await router(
              { article, body, refs: articleRefs },
              toolsClients,
              signal,
            );

            const [topicOut, sourceOut, entityOut, citeOut] = await Promise.all([
              topicScout(
                { article, body, task: routerOut.topicScoutTask },
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
              },
              toolsClients,
              vault,
              signal,
            );

            // Summary is part of the semantic plan. Final topics/cites are NOT:
            // the apply phase re-gates reviewer output against fresh vault state.
            const summary = await summarizer(
              { article, body },
              { client: clients.summaryClient, model: clients.summaryModel },
              signal,
            );

            return {
              articleId: article.id,
              outcome: 'planned',
              plan: {
                article,
                stableId,
                sourceFilename,
                sourcePath,
                body,
                summary,
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
      yield {
        type: 'phase',
        phase: 'plan-article-tree',
        detail: `planned=${tally.planned} skipped=${tally.skipped} deferred=${tally.deferred} failed=${tally.failed}`,
        counts: tally,
      };
    },
  });

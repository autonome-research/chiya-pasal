/**
 * Serial deterministic application of semantic librarian article plans.
 *
 * The planner produces reviewer/summary outputs without mutating the vault.
 * This phase re-reads current vault state, re-runs gates, writes one article at
 * a time, and owns ArticleStore status transitions. This prevents concurrent
 * article runners from losing topic/backlink updates.
 */

import { basename } from 'path';
import { requireCtx, type Phase } from 'thread-phase';

import { ArticleStore } from '../shared/article-store.js';
import type {
  ArticleResult,
  LibrarianCtx,
  PlannedArticle,
} from '../shared/librarian-types.js';
import type { VaultFs } from '../tools/vault.js';
import {
  appendCitedBy,
  appendMemberSource,
  formatSourcePage,
  formatTopicPage,
} from './page-templates.js';
import { applyReconcileAndGate } from './reviewer.js';

/** Per-article write log: tracks pre-state so a failed article apply can roll back. */
function makeWriter(vault: VaultFs): {
  write: (path: string, content: string) => Promise<void>;
  rollback: () => Promise<void>;
} {
  const before = new Map<string, string | null>();
  const writtenInOrder: string[] = [];
  return {
    async write(path, content) {
      if (!before.has(path)) {
        const existed = await vault.exists(path);
        before.set(path, existed ? await vault.read(path) : null);
      }
      await vault.write(path, content);
      writtenInOrder.push(path);
    },
    async rollback() {
      for (const path of [...writtenInOrder].reverse()) {
        const prior = before.get(path);
        if (prior === null) {
          try {
            await vault.unlink(path);
          } catch {
            // Already absent; ignore.
          }
        } else if (prior !== undefined) {
          await vault.write(path, prior);
        }
      }
    },
  };
}

function sourcePageMatchesArticle(content: string, plan: PlannedArticle): boolean {
  const url = plan.article.url ?? '';
  if (url && content.includes(`url: ${url}`)) return true;
  if (content.includes(`# ${plan.article.title}`)) return true;
  return false;
}

async function applyPlannedArticle(
  plan: PlannedArticle,
  vault: VaultFs,
  store: ArticleStore,
): Promise<ArticleResult> {
  // If the source page appeared between planning and apply, do not overwrite
  // it. Treat a matching existing page as crash recovery; otherwise skip as a
  // duplicate/foreign page collision.
  if (await vault.exists(plan.sourcePath)) {
    const existing = await vault.read(plan.sourcePath);
    if (sourcePageMatchesArticle(existing, plan)) {
      store.markDone(plan.article.id, [plan.sourcePath]);
      return {
        articleId: plan.article.id,
        outcome: 'done',
        reason: 'existing-source-recovered',
        sourcePagePath: plan.sourcePath,
        topicPagePaths: [],
        backlinkPagePaths: [],
      };
    }

    store.markSkipped(plan.article.id, 'already-ingested');
    return {
      articleId: plan.article.id,
      outcome: 'skipped',
      reason: 'already-ingested',
      topicPagePaths: [],
      backlinkPagePaths: [],
    };
  }

  const writer = makeWriter(vault);
  try {
    // Re-gate against fresh vault state at apply time. Another article earlier
    // in this serial phase may have created topics/backlinks after this plan
    // was generated.
    const topicPaths = await vault.list('wiki/topics/*.md');
    const existingTopicSlugs = new Set(topicPaths.map((p) => basename(p, '.md')));
    const gated = await applyReconcileAndGate({
      reviewer: plan.reviewer,
      existingTopicSlugs,
      sourceExists: (filename) => vault.exists(`wiki/sources/${filename}.md`),
      entityExists: (slug) => vault.exists(`wiki/entities/${slug}.md`),
    });

    const memberEntry = {
      filename: plan.sourceFilename,
      title: plan.article.title,
      collected: plan.article.collectedAt,
    };

    // 1. Topic-page touches first. Append/create operations are idempotent,
    // and source page creation is saved for last as the completion marker.
    const topicPagePaths: string[] = [];
    const newTopicsBySlug = new Map(
      gated.newTopicsToCreate.map((t) => [t.slug, t.definition]),
    );
    for (const slug of gated.existingTopicSlugs) {
      if (slug === 'uncategorized') continue;
      const topicPath = `wiki/topics/${slug}.md`;
      const newDef = newTopicsBySlug.get(slug);
      if (newDef && !(await vault.exists(topicPath))) {
        const content = formatTopicPage({
          slug,
          created: new Date(),
          updated: new Date(),
          definition: newDef,
          members: [memberEntry],
          relatedTopics: [],
        });
        await writer.write(topicPath, content);
      } else if (await vault.exists(topicPath)) {
        const existing = await vault.read(topicPath);
        const updated = appendMemberSource(existing, memberEntry);
        if (updated !== existing) await writer.write(topicPath, updated);
      } else {
        continue;
      }
      topicPagePaths.push(topicPath);
    }

    // 2. Backlinks: cited source pages + entity pages.
    const backlinkPagePaths: string[] = [];
    const backlinkOn = async (path: string): Promise<void> => {
      if (!(await vault.exists(path))) return;
      const existing = await vault.read(path);
      const updated = appendCitedBy(existing, {
        filename: plan.sourceFilename,
        title: plan.article.title,
      });
      if (updated !== existing) {
        await writer.write(path, updated);
        backlinkPagePaths.push(path);
      }
    };
    for (const citeFilename of gated.citeFilenames) {
      await backlinkOn(`wiki/sources/${citeFilename}.md`);
    }
    for (const entitySlug of gated.entitySlugs) {
      await backlinkOn(`wiki/entities/${entitySlug}.md`);
    }

    // 3. Source page last: after this point a crash can be treated as a
    // completed write whose DB row may need recovery.
    const sourceContent = formatSourcePage({
      stableId: plan.stableId,
      url: plan.article.url ?? '',
      arxivId: plan.stableId.kind === 'arxiv' ? plan.stableId.id : undefined,
      doi: plan.stableId.kind === 'doi' ? plan.stableId.doi : undefined,
      sourceName: plan.article.source,
      collected: plan.article.collectedAt,
      title: plan.article.title,
      field: plan.article.field,
      topics: gated.existingTopicSlugs,
      cites: gated.citeFilenames,
      summary: plan.summary,
    });
    await writer.write(plan.sourcePath, sourceContent);

    const allPaths = [plan.sourcePath, ...topicPagePaths, ...backlinkPagePaths];
    store.markDone(plan.article.id, allPaths);

    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const slugSummary = gated.existingTopicSlugs.join(', ') || '(no topics)';
    const gateNote =
      gated.gateStats.foldedSlugs +
        gated.gateStats.droppedHallucinations +
        gated.gateStats.rejectedNearDuplicates +
        gated.gateStats.rejectedThinDefinition >
      0
        ? ` [gate: fold=${gated.gateStats.foldedSlugs} drop=${gated.gateStats.droppedHallucinations} dup=${gated.gateStats.rejectedNearDuplicates} thin=${gated.gateStats.rejectedThinDefinition}]`
        : '';

    return {
      articleId: plan.article.id,
      outcome: 'done',
      sourcePagePath: plan.sourcePath,
      topicPagePaths,
      backlinkPagePaths,
      logEntry: `[${ts}] ingest-v3 | ${plan.article.title.slice(0, 80)} → ${slugSummary}${gateNote}`,
    };
  } catch (err) {
    await writer.rollback();
    const reason = err instanceof Error ? err.message : String(err);
    store.markFailed(plan.article.id, reason.slice(0, 200));
    return {
      articleId: plan.article.id,
      outcome: 'failed',
      reason: reason.slice(0, 200),
      topicPagePaths: [],
      backlinkPagePaths: [],
    };
  }
}

export const applyArticlePlans = (vault: VaultFs, store: ArticleStore): Phase<LibrarianCtx> => ({
  name: 'apply-article-plans',
  async *run(ctx) {
    const plans = requireCtx(ctx, 'articlePlans', 'apply-article-plans');
    const results: ArticleResult[] = [];

    for (const result of plans) {
      if (result.outcome === 'planned') {
        results.push(await applyPlannedArticle(result.plan, vault, store));
        continue;
      }

      if (result.outcome === 'deferred') {
        store.markPending(result.articleId);
        results.push({
          articleId: result.articleId,
          outcome: 'skipped',
          reason: result.reason,
          topicPagePaths: [],
          backlinkPagePaths: [],
        });
        continue;
      }

      if (result.outcome === 'skipped') {
        // Existing source pages are rechecked here so a crash after source
        // write but before DB mark can recover as done instead of skipped.
        if (result.reason === 'already-ingested' && result.sourcePath && await vault.exists(result.sourcePath)) {
          const row = store.getById(result.articleId);
          const content = await vault.read(result.sourcePath);
          if (row && ((row.url && content.includes(`url: ${row.url}`)) || content.includes(`# ${row.title}`))) {
            store.markDone(result.articleId, [result.sourcePath]);
            results.push({
              articleId: result.articleId,
              outcome: 'done',
              reason: 'existing-source-recovered',
              sourcePagePath: result.sourcePath,
              topicPagePaths: [],
              backlinkPagePaths: [],
            });
            continue;
          }
        }
        store.markSkipped(result.articleId, result.reason);
        results.push({
          articleId: result.articleId,
          outcome: 'skipped',
          reason: result.reason,
          topicPagePaths: [],
          backlinkPagePaths: [],
        });
        continue;
      }

      store.markFailed(result.articleId, result.reason);
      results.push({
        articleId: result.articleId,
        outcome: 'failed',
        reason: result.reason,
        topicPagePaths: [],
        backlinkPagePaths: [],
      });
    }

    ctx.results = results;
    const tally = results.reduce(
      (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
      { done: 0, skipped: 0, failed: 0 } as Record<string, number>,
    );
    yield {
      type: 'phase',
      phase: 'apply-article-plans',
      detail: `done=${tally.done} skipped=${tally.skipped} failed=${tally.failed}`,
      counts: tally,
    };
  },
});

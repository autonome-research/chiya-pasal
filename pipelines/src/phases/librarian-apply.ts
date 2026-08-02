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
  DryRunArticlePreview,
  LibrarianCtx,
  PlannedArticle,
} from '../shared/librarian-types.js';
import type { VaultFs } from '../tools/vault.js';
import { appendMentionedIn, formatEntityPage } from './entity-templates.js';
import {
  appendCitedBy,
  appendMemberSource,
  formatSourcePage,
  formatTopicPage,
  type ExternalRef,
} from './page-templates.js';
import {
  applyReconcileAndGate,
  isReviewerFailureReason,
  reviewerFailureAttempts,
  type GatedRecommendations,
} from './reviewer.js';

/** Sink for unresolved-citation demand (tier 2 of citation completion).
 *  Wired to the shared cache's ledger by the entry point; absent in tests
 *  and legacy single-tenant runs, where it degrades to a no-op. */
export type DemandRecorder = (
  entries: Array<{ refKind: 'arxiv' | 'doi'; refId: string; citingStableId: string }>,
) => void;

/** Render at most this many external refs on a source page. The demand
 *  ledger records ALL of them; the page cap is purely readability. */
const EXTERNAL_REFS_RENDER_CAP = 10;

interface UnresolvedRefs {
  externalRefs: ExternalRef[];
  demand: Array<{ refKind: 'arxiv' | 'doi'; refId: string; citingStableId: string }>;
}

/**
 * The article's refs that do NOT resolve against this user's library —
 * re-checked at apply time (the library may have grown since planning).
 * Self-refs (the article's own id appearing in its text) are excluded.
 */
function computeUnresolvedRefs(plan: PlannedArticle, store: ArticleStore): UnresolvedRefs {
  const externalRefs: ExternalRef[] = [];
  const demand: UnresolvedRefs['demand'] = [];

  const ownArxiv = plan.stableId.kind === 'arxiv' ? plan.stableId.id.replace(/v\d+$/i, '') : null;
  const ownDoi = plan.stableId.kind === 'doi' ? plan.stableId.doi.toLowerCase() : null;

  const seen = new Set<string>();
  for (const raw of plan.article.refsArxiv ?? []) {
    const id = raw.trim().replace(/v\d+$/i, '');
    if (!id || id === ownArxiv || seen.has(`a:${id}`)) continue;
    seen.add(`a:${id}`);
    if (store.findByArxivId(id)) continue; // resolved in-library → cite path
    demand.push({ refKind: 'arxiv', refId: id, citingStableId: plan.sourceFilename });
    externalRefs.push({ label: `arXiv:${id}`, url: `https://arxiv.org/abs/${id}` });
  }
  for (const raw of plan.article.refsDoi ?? []) {
    const doi = raw.trim().toLowerCase();
    if (!doi || doi === ownDoi || seen.has(`d:${doi}`)) continue;
    seen.add(`d:${doi}`);
    if (store.findByDoi(doi)) continue;
    demand.push({ refKind: 'doi', refId: doi, citingStableId: plan.sourceFilename });
    externalRefs.push({ label: `doi:${doi}`, url: `https://doi.org/${doi}` });
  }

  return { externalRefs: externalRefs.slice(0, EXTERNAL_REFS_RENDER_CAP), demand };
}

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

function gateNoteFromStats(gateStats: GatedRecommendations['gateStats']): string {
  return gateStats.foldedSlugs +
    gateStats.droppedHallucinations +
    gateStats.rejectedNearDuplicates +
    gateStats.rejectedThinDefinition +
    gateStats.fuzzyCorrected >
    0
    ? ` [gate: fold=${gateStats.foldedSlugs} drop=${gateStats.droppedHallucinations} dup=${gateStats.rejectedNearDuplicates} thin=${gateStats.rejectedThinDefinition} fuzzy=${gateStats.fuzzyCorrected}]`
    : '';
}

/** A planned article carrying a reviewer error only reaches apply after its
 *  deferrals are exhausted (REVIEWER_FAILURE_MAX_DEFERRALS) — it files as
 *  uncategorized as a last resort, and the journal must say so. */
function degradedReviewerNote(plan: PlannedArticle): string {
  if (!plan.reviewer.error) return '';
  const attempt = reviewerFailureAttempts(plan.article.statusReason) + 1;
  return ` [reviewer-failed x${attempt}: degraded uncategorized filing — ${plan.reviewer.error.slice(0, 80)}]`;
}

async function applyPlannedArticle(
  plan: PlannedArticle,
  vault: VaultFs,
  store: ArticleStore,
  recordDemand?: DemandRecorder,
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
    });

    const memberEntry = {
      filename: plan.sourceFilename,
      title: plan.article.title,
      collected: plan.article.collectedAt,
    };

    // 1. Topic-page touches first. Append/create operations are idempotent,
    // and source page creation is saved for last as the completion marker.
    const topicPagePaths: string[] = [];
    const newTopicsBySlug = new Map(gated.newTopicsToCreate.map((t) => [t.slug, t]));
    for (const slug of gated.existingTopicSlugs) {
      if (slug === 'uncategorized') continue;
      const topicPath = `wiki/topics/${slug}.md`;
      const newTopic = newTopicsBySlug.get(slug);
      if (newTopic && !(await vault.exists(topicPath))) {
        const content = formatTopicPage({
          slug,
          created: new Date(),
          updated: new Date(),
          definition: newTopic.definition,
          members: [memberEntry],
          relatedTopics: [],
          // Soft cluster metadata from birth: an unclustered page born today
          // is a page nothing can recover clusters for later.
          clusters: newTopic.clusters,
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

    // 3. Entity upserts. Unlike cites, a missing entity page is CREATED —
    //    the reviewer's entity recommendations used to be silently discarded
    //    whenever the page didn't already exist, so the namespace could never
    //    grow. Still before the source page: it stays the completion marker.
    for (const entity of gated.entities) {
      const entityPath = `wiki/entities/${entity.slug}.md`;
      const existing = await vault.readOptional(entityPath);
      if (existing === null) {
        await writer.write(
          entityPath,
          formatEntityPage({
            slug: entity.slug,
            name: entity.name,
            kind: entity.kind,
            created: new Date(),
            mentionedIn: [memberEntry],
          }),
        );
        backlinkPagePaths.push(entityPath);
        continue;
      }
      const updated = appendMentionedIn(existing, memberEntry);
      if (updated !== existing) {
        await writer.write(entityPath, updated);
        backlinkPagePaths.push(entityPath);
      }
    }

    // 4. Source page last: after this point a crash can be treated as a
    // completed write whose DB row may need recovery.
    const unresolved = computeUnresolvedRefs(plan, store);
    const sourceContent = formatSourcePage({
      stableId: plan.stableId,
      url: plan.article.url ?? '',
      arxivId: plan.stableId.kind === 'arxiv' ? plan.stableId.id : undefined,
      doi: plan.stableId.kind === 'doi' ? plan.stableId.doi : undefined,
      sourceName: plan.article.source,
      collected: plan.article.collectedAt,
      title: plan.article.title,
      field: plan.article.field,
      // Shared-pipeline quality signals; omitted entirely for unscored rows so
      // "unscored" stays distinguishable from "scored low".
      rigor: plan.article.qualityRigor,
      evidence: plan.article.qualityEvidence,
      topics: gated.existingTopicSlugs,
      cites: gated.citeFilenames,
      related: gated.relatedFilenames,
      externalRefs: unresolved.externalRefs,
      summary: plan.summary,
    });
    await writer.write(plan.sourcePath, sourceContent);

    // Tier-2 citation demand: after the source page is durably written, so
    // the ledger never references a page that doesn't exist. Recording is
    // idempotent; a recorder failure must not fail the article.
    if (recordDemand && unresolved.demand.length > 0) {
      try {
        recordDemand(unresolved.demand);
      } catch (err) {
        console.warn(
          `[apply] citation-demand recording failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const allPaths = [plan.sourcePath, ...topicPagePaths, ...backlinkPagePaths];
    store.markDone(plan.article.id, allPaths);

    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const slugSummary = gated.existingTopicSlugs.join(', ') || '(no topics)';
    const gateNote = gateNoteFromStats(gated.gateStats);

    return {
      articleId: plan.article.id,
      outcome: 'done',
      sourcePagePath: plan.sourcePath,
      topicPagePaths,
      backlinkPagePaths,
      logEntry: `[${ts}] ingest-v3 | ${plan.article.title.slice(0, 80)} → ${slugSummary}${gateNote}${degradedReviewerNote(plan)}`,
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

async function previewPlannedArticle(
  plan: PlannedArticle,
  vault: VaultFs,
): Promise<DryRunArticlePreview> {
  try {
    // readOptional validates the path through VaultFs' sandbox guard while
    // still allowing the normal "file does not exist yet" preview path.
    const existingSource = await vault.readOptional(plan.sourcePath);
    if (existingSource !== null) {
      return {
        articleId: plan.article.id,
        outcome: 'would-skip',
        reason: sourcePageMatchesArticle(existingSource, plan)
          ? 'existing-source-recovered'
          : 'already-ingested',
        sourcePagePath: plan.sourcePath,
        topicPagePaths: [],
        backlinkPagePaths: [],
      };
    }

    const topicPaths = await vault.list('wiki/topics/*.md');
    const existingTopicSlugs = new Set(topicPaths.map((p) => basename(p, '.md')));
    const gated = await applyReconcileAndGate({
      reviewer: plan.reviewer,
      existingTopicSlugs,
      sourceExists: (filename) => vault.exists(`wiki/sources/${filename}.md`),
    });

    const topicPagePaths: string[] = [];
    const newTopicsBySlug = new Map(gated.newTopicsToCreate.map((t) => [t.slug, t]));
    for (const slug of gated.existingTopicSlugs) {
      if (slug === 'uncategorized') continue;
      const topicPath = `wiki/topics/${slug}.md`;
      const newTopic = newTopicsBySlug.get(slug);
      const existingTopic = await vault.readOptional(topicPath);
      if (newTopic || existingTopic !== null) topicPagePaths.push(topicPath);
    }

    const backlinkPagePaths: string[] = [];
    const backlinkWouldChange = async (path: string): Promise<void> => {
      if (!(await vault.exists(path))) return;
      const existing = await vault.read(path);
      const updated = appendCitedBy(existing, {
        filename: plan.sourceFilename,
        title: plan.article.title,
      });
      if (updated !== existing) backlinkPagePaths.push(path);
    };
    for (const citeFilename of gated.citeFilenames) {
      await backlinkWouldChange(`wiki/sources/${citeFilename}.md`);
    }
    for (const entity of gated.entities) {
      const entityPath = `wiki/entities/${entity.slug}.md`;
      const existing = await vault.readOptional(entityPath);
      if (existing === null) {
        backlinkPagePaths.push(entityPath); // would be created
        continue;
      }
      const memberEntry = {
        filename: plan.sourceFilename,
        title: plan.article.title,
        collected: plan.article.collectedAt,
      };
      if (appendMentionedIn(existing, memberEntry) !== existing) {
        backlinkPagePaths.push(entityPath);
      }
    }

    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const slugSummary = gated.existingTopicSlugs.join(', ') || '(no topics)';
    return {
      articleId: plan.article.id,
      outcome: 'would-write',
      sourcePagePath: plan.sourcePath,
      topicPagePaths,
      backlinkPagePaths,
      logEntry: `[${ts}] ingest-v3 | ${plan.article.title.slice(0, 80)} → ${slugSummary}${gateNoteFromStats(gated.gateStats)}${degradedReviewerNote(plan)}`,
    };
  } catch (err) {
    return {
      articleId: plan.article.id,
      outcome: 'would-fail',
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      topicPagePaths: [],
      backlinkPagePaths: [],
    };
  }
}

async function previewSkippedPlan(
  result: { articleId: number; reason: string; sourcePath?: string },
  vault: VaultFs,
  store: ArticleStore,
): Promise<DryRunArticlePreview> {
  try {
    if (result.reason === 'already-ingested' && result.sourcePath) {
      const row = store.getById(result.articleId);
      const content = await vault.readOptional(result.sourcePath);
      if (row && content && ((row.url && content.includes(`url: ${row.url}`)) || content.includes(`# ${row.title}`))) {
        return {
          articleId: result.articleId,
          outcome: 'would-skip',
          reason: 'existing-source-recovered',
          sourcePagePath: result.sourcePath,
          topicPagePaths: [],
          backlinkPagePaths: [],
        };
      }
    }
    return {
      articleId: result.articleId,
      outcome: 'would-skip',
      reason: result.reason,
      sourcePagePath: result.sourcePath,
      topicPagePaths: [],
      backlinkPagePaths: [],
    };
  } catch (err) {
    return {
      articleId: result.articleId,
      outcome: 'would-fail',
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      topicPagePaths: [],
      backlinkPagePaths: [],
    };
  }
}

export interface ApplyArticlePlansOptions {
  /** Re-run gates and report what would happen without vault/DB mutation. */
  dryRun?: boolean;
  /** Tier-2 citation demand sink. Never invoked in dry-run mode. */
  demandRecorder?: DemandRecorder;
}

export const applyArticlePlans = (
  vault: VaultFs,
  store: ArticleStore,
  options: ApplyArticlePlansOptions = {},
): Phase<LibrarianCtx> => ({
  name: options.dryRun ? 'preview-article-plans' : 'apply-article-plans',
  async *run(ctx) {
    const plans = requireCtx(ctx, 'articlePlans', 'apply-article-plans');
    const dryRun = options.dryRun ?? ctx.dryRun ?? false;

    if (dryRun) {
      const previews: DryRunArticlePreview[] = [];
      for (const result of plans) {
        if (result.outcome === 'planned') {
          previews.push(await previewPlannedArticle(result.plan, vault));
        } else if (result.outcome === 'deferred') {
          previews.push({ articleId: result.articleId, outcome: 'would-defer', reason: result.reason, topicPagePaths: [], backlinkPagePaths: [] });
        } else if (result.outcome === 'skipped') {
          previews.push(await previewSkippedPlan(result, vault, store));
        } else {
          previews.push({ articleId: result.articleId, outcome: 'would-fail', reason: result.reason, topicPagePaths: [], backlinkPagePaths: [] });
        }
      }
      ctx.dryRunPreviews = previews;
      ctx.results = previews.map((p): ArticleResult => ({
        articleId: p.articleId,
        outcome: p.outcome === 'would-write' ? 'done' : p.outcome === 'would-fail' ? 'failed' : 'skipped',
        reason: p.reason ?? 'dry-run',
        sourcePagePath: p.sourcePagePath,
        topicPagePaths: p.topicPagePaths,
        backlinkPagePaths: p.backlinkPagePaths,
        logEntry: p.logEntry,
      }));
      const tally = previews.reduce(
        (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
        { 'would-write': 0, 'would-skip': 0, 'would-fail': 0, 'would-defer': 0 } as Record<string, number>,
      );
      for (const p of previews) {
        yield {
          type: 'agent_activity',
          agent: 'preview-article-plans',
          action: p.outcome,
          detail: `article=${p.articleId}${p.sourcePagePath ? ` source=${p.sourcePagePath}` : ''}${p.reason ? ` reason=${p.reason}` : ''}`,
        };
      }
      yield {
        type: 'phase',
        phase: 'preview-article-plans',
        detail: `would-write=${tally['would-write']} would-skip=${tally['would-skip']} would-fail=${tally['would-fail']} would-defer=${tally['would-defer']}`,
        counts: tally,
      };
      return;
    }

    const results: ArticleResult[] = [];

    for (const result of plans) {
      if (result.outcome === 'planned') {
        results.push(await applyPlannedArticle(result.plan, vault, store, options.demandRecorder));
        continue;
      }

      if (result.outcome === 'deferred') {
        // Reviewer-failure deferrals persist their attempt marker so the next
        // run's planner can cap retries. The store has no reasoned-pending
        // transition: markSkipped writes status_reason, and markPending then
        // restores 'pending' without clearing it.
        if (isReviewerFailureReason(result.reason)) {
          store.markSkipped(result.articleId, result.reason.slice(0, 200));
        }
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
    // Reviewer outages surface in the journal instead of laundering into
    // uncategorized filings.
    tally.reviewerDeferred = plans.filter(
      (p) => p.outcome === 'deferred' && isReviewerFailureReason(p.reason),
    ).length;
    yield {
      type: 'phase',
      phase: 'apply-article-plans',
      detail: `done=${tally.done} skipped=${tally.skipped} failed=${tally.failed} reviewer-deferred=${tally.reviewerDeferred}`,
      counts: tally,
    };
  },
});

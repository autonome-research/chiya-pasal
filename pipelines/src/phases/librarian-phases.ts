/**
 * Librarian phases. Sources are first-class wiki pages, topics are routing
 * nodes. See src/librarian.ts for the phase composition.
 *
 * Phases below are organized in execution order:
 *   - reapStale + loadBatch: queue management.
 *   - batchEnrich + batchExtractRefs: pre-fan-out prep (full-text fetch + ref
 *     extraction). No LLM, no per-article work yet.
 *   - perArticleTree: bounded-concurrency fan-out across the batch. Each
 *     per-article runner does router → 4 scouts (parallel) → reviewer →
 *     deterministic write (source page + topic touches + backlinks).
 *   - mergeMetadata + commitLocal close out the batch.
 */

import {
  requireCtx,
  type Phase,
} from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';
import { setMaxListeners } from 'events';
import { basename } from 'path';

import { ArticleStore } from '../shared/article-store.js';
import type {
  ArticleResult,
  EnrichedArticle,
  ExtractedRefs,
  LibrarianCtx,
} from '../shared/librarian-types.js';
import type { GitOps } from '../tools/git.js';
import type { VaultFs } from '../tools/vault.js';
import { extractArxivIds, extractDois } from '../shared/refs.js';
import {
  appendCitedBy,
  appendMemberSource,
  formatTopicPage,
  stableIdForUrl,
  stableIdToFilename,
} from './page-templates.js';

// ---------------------------------------------------------------------------
// reapStale + loadBatch — queue management before the fan-out.
// ---------------------------------------------------------------------------

const STALE_PROCESSING_MINUTES = 60;

export const reapStale = (store: ArticleStore): Phase<LibrarianCtx> => ({
  name: 'reap-stale',
  async *run(ctx) {
    const reaped = store.reapStaleProcessing(STALE_PROCESSING_MINUTES);
    ctx.reaped = reaped;
    yield {
      type: 'phase',
      phase: 'reap-stale',
      detail: reaped > 0 ? `recovered ${reaped} stuck row(s)` : 'no stale rows',
      counts: { reaped },
    };
  },
});

export const loadBatch = (store: ArticleStore): Phase<LibrarianCtx> => ({
  name: 'load-batch',
  async *run(ctx) {
    const batch = store.listPending(ctx.batchSize);
    ctx.batch = batch;
    for (const row of batch) store.markProcessing(row.id);
    if (batch.length === 0) ctx.stop = { reason: 'queue-empty' };
    yield {
      type: 'phase',
      phase: 'load-batch',
      detail: `${batch.length} article(s) pulled (status='processing')`,
      counts: {
        batch: batch.length,
        totalPending: store.countByStatus().pending + batch.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// batchEnrich — fan-out HTTP fetches for articles whose snippet is too thin
// to classify or summarize.
// ---------------------------------------------------------------------------

const ENRICH_SNIPPET_THRESHOLD = 200;
const ENRICH_CONCURRENCY = 4;
const ENRICH_FETCH_TIMEOUT_MS = 15_000;
const ENRICH_BODY_CAP = 50_000;
const ENRICH_USER_AGENT = 'chiya-librarian/2.0';

/**
 * Decide whether a row needs an HTTP fetch. Skip when the snippet is already
 * fat enough OR when there's no http(s) URL we can simply GET.
 */
export function shouldFetch(article: { snippet: string | null; url: string | null }): boolean {
  const { snippet, url } = article;
  if (snippet !== null && snippet.length >= ENRICH_SNIPPET_THRESHOLD) return false;
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

/**
 * Minimal HTML→plain-text pass for enrichment bodies. Not a full parser:
 *   - Drop <script> / <style> blocks (with content) entirely.
 *   - Turn block-ish open tags (<br>, <p>, <div>, <li>) into newlines.
 *   - Strip everything else that looks like a tag.
 *   - Decode the small set of HTML entities we actually see in the wild.
 *   - Collapse whitespace runs and cap length.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html;
  // Drop script/style blocks (with their contents) before any other tag pass.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  // Block-ish open tags become newlines so paragraph boundaries survive.
  s = s.replace(/<(?:br|p|div|li)\b[^>]*\/?>/gi, '\n');
  // Strip every remaining tag.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // Decode the entities we care about. Order matters for &amp;.
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  // Collapse whitespace runs. Keep newlines as a single \n separator.
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > ENRICH_BODY_CAP) s = s.slice(0, ENRICH_BODY_CAP);
  return s;
}

interface FetchOutcome {
  body: string;
  enriched: boolean;
  enrichError?: string;
}

async function fetchOneArticle(
  url: string,
  fallback: string,
  outerSignal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENRICH_FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': ENRICH_USER_AGENT, accept: 'text/html, text/plain;q=0.9, */*;q=0.5' },
    });
    if (!res.ok) {
      return { body: fallback, enriched: false, enrichError: `http ${res.status}` };
    }
    const raw = await res.text();
    const text = htmlToText(raw);
    if (!text) return { body: fallback, enriched: false, enrichError: 'empty body' };
    return { body: text, enriched: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { body: fallback, enriched: false, enrichError: msg.slice(0, 200) };
  } finally {
    clearTimeout(timeout);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

export const batchEnrich = (): Phase<LibrarianCtx> => ({
  name: 'batch-enrich',
  async *run(ctx) {
    const batch = requireCtx(ctx, 'batch', 'batch-enrich');

    const enriched: EnrichedArticle[] = new Array(batch.length);
    let fetched = 0;
    let skipped = 0;
    let errors = 0;

    // Pre-fill skips so the fanout only sees rows that actually need a GET.
    type FetchSlot = { idx: number; articleId: number; url: string; fallback: string };
    const slots: FetchSlot[] = [];
    for (let i = 0; i < batch.length; i++) {
      const a = batch[i]!;
      const fallback = a.snippet ?? '';
      if (!shouldFetch(a)) {
        enriched[i] = { articleId: a.id, body: fallback, enriched: false };
        skipped++;
        continue;
      }
      slots.push({ idx: i, articleId: a.id, url: a.url!, fallback });
    }

    if (slots.length > 0) {
      const results = await boundedFanout({
        items: slots,
        concurrency: ENRICH_CONCURRENCY,
        mode: 'collect' as const,
        signal: ctx.signal,
        runner: async (slot, _i, signal) => fetchOneArticle(slot.url, slot.fallback, signal),
      });
      for (let j = 0; j < slots.length; j++) {
        const slot = slots[j]!;
        const r = results[j]!;
        if (r.ok) {
          const o = r.value;
          enriched[slot.idx] = {
            articleId: slot.articleId,
            body: o.body,
            enriched: o.enriched,
            ...(o.enrichError ? { enrichError: o.enrichError } : {}),
          };
          if (o.enriched) fetched++;
          else errors++;
        } else {
          // boundedFanout cancelled this slot (e.g. ctx.signal aborted before dispatch).
          enriched[slot.idx] = {
            articleId: slot.articleId,
            body: slot.fallback,
            enriched: false,
            enrichError: r.error.message.slice(0, 200),
          };
          errors++;
        }
      }
    }

    ctx.enriched = enriched;
    yield {
      type: 'phase',
      phase: 'batch-enrich',
      detail: `${enriched.length} article(s); ${fetched} fetched / ${skipped} skipped${errors > 0 ? ' / ' + errors + ' errors' : ''}`,
      counts: { articles: enriched.length, fetched, skipped, errors },
    };
  },
});

// ---------------------------------------------------------------------------
// batchExtractRefs — pure-CPU fan-out applying refs.ts to each article body.
// ---------------------------------------------------------------------------

export const batchExtractRefs = (): Phase<LibrarianCtx> => ({
  name: 'batch-extract-refs',
  async *run(ctx) {
    const enriched = requireCtx(ctx, 'enriched', 'batch-extract-refs');
    const refs: ExtractedRefs[] = enriched.map((e) => ({
      articleId: e.articleId,
      arxivIds: extractArxivIds(e.body),
      dois: extractDois(e.body),
    }));
    ctx.refs = refs;
    const totalRefs = refs.reduce((acc, r) => acc + r.arxivIds.length + r.dois.length, 0);
    yield {
      type: 'phase',
      phase: 'batch-extract-refs',
      detail: `${refs.length} article(s) / ${totalRefs} ref(s) extracted`,
      counts: { articles: refs.length, refs: totalRefs },
    };
  },
});


// ---------------------------------------------------------------------------
// perArticleTree (v3) — bounded-concurrency fan-out across the batch. Each
// per-article runner does:
//   1. Idempotency check (skip if URL missing or source page already exists).
//   2. Router — one no-tool LLM call writing per-scope task instructions.
//   3. Fan-out (Promise.all) of four scouts:
//      topicScout / sourceScout / entityScout / citeTracker. Each is a
//      tool-using LLM call that explores one slice of the vault.
//   4. Reviewer — sequential LLM call with vault_read; recommends final
//      topics, cites, related sources, and entities.
//   5. Reconcile + gate — deterministic check: fold false-new topics, drop
//      hallucinations, gate new-topic creation by near-duplicate +
//      definition-substantiveness.
//   6. Summary — fast no-tool LLM call to write 2-3 paragraph prose.
//   7. Deterministic writes — source page, topic-page touches, backlinks.
//
// Per-article rollback: a small in-runner write log captures pre-write
// state for every vault.write call so a throw mid-runner doesn't leave a
// half-written article. Same shape as the v1 WriteTracker but inline since
// no agent has vault_write here (only the librarian's own deterministic
// step writes).
// ---------------------------------------------------------------------------

import { callSummary, type Summarizer } from './summary.js';
import { runRouter, type RouterRunner } from './librarian-router.js';
import { runTopicScout, type TopicScoutRunner } from './scouts/topic-scout.js';
import { runSourceScout, type SourceScoutRunner } from './scouts/source-scout.js';
import { runEntityScout, type EntityScoutRunner } from './scouts/entity-scout.js';
import { runCiteTracker, type CiteTrackerRunner } from './scouts/cite-tracker.js';
import {
  applyReconcileAndGate,
  runReviewer,
  type ReviewerRunner,
} from './reviewer.js';
import { formatSourcePage } from './page-templates.js';

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

/** Per-runner write log: tracks pre-state so a throw can roll back atomically. */
function makeWriter(vault: VaultFs): {
  write: (path: string, content: string) => Promise<void>;
  rollback: () => Promise<void>;
  written: () => string[];
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
      // Reverse order so dependent writes undo cleanly.
      for (const path of [...writtenInOrder].reverse()) {
        const prior = before.get(path);
        if (prior === null) {
          try {
            await vault.unlink(path);
          } catch {
            // already gone or never created; ignore
          }
        } else if (prior !== undefined) {
          await vault.write(path, prior);
        }
      }
    },
    written() {
      return [...writtenInOrder];
    },
  };
}

export const perArticleTree =
  (
    clients: PerArticleClients,
    vault: VaultFs,
    store: ArticleStore,
    deps: PerArticleDeps = {},
  ): Phase<LibrarianCtx> => ({
    name: 'per-article-tree',
    async *run(ctx) {
      const batch = requireCtx(ctx, 'batch', 'per-article-tree');
      const enriched = requireCtx(ctx, 'enriched', 'per-article-tree');
      const refs = requireCtx(ctx, 'refs', 'per-article-tree');

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
        runner: async (article, _idx, parentSignal): Promise<ArticleResult> => {
          // 1. Idempotency.
          const sid = stableIdForUrl(article.url ?? '');
          if (!sid) {
            store.markSkipped(article.id, 'no-url-no-stable-id');
            return {
              articleId: article.id,
              outcome: 'skipped',
              reason: 'no-url-no-stable-id',
              topicPagePaths: [],
              backlinkPagePaths: [],
            };
          }
          const sourceFilename = stableIdToFilename(sid);
          const sourcePath = `wiki/sources/${sourceFilename}.md`;
          if (await vault.exists(sourcePath)) {
            store.markSkipped(article.id, 'already-ingested');
            return {
              articleId: article.id,
              outcome: 'skipped',
              reason: 'already-ingested',
              topicPagePaths: [],
              backlinkPagePaths: [],
            };
          }

          // Per-article child AbortController. Two purposes:
          //   - Scope cleanup: the child is GC'd when the runner returns,
          //     so any listeners the SDK attached to the child signal
          //     (one per fetch + retries inside each runAgentWithTools
          //     sub-call) go with it. ctx.signal accumulates only the
          //     parent listener registered below — at most one per
          //     concurrent runner, well under the default cap.
          //   - Listener-cap suppression: each runner has 7 LLM sub-
          //     calls (router + 4 scouts + reviewer + summary), each of
          //     which can register multiple listeners on its signal as
          //     it iterates tool rounds. The cumulative count per
          //     CHILD signal can exceed Node's default 10-listener cap
          //     during the runner's lifetime — not an actual leak, just
          //     transient. Bumping the child's cap silences the
          //     spurious warning without raising it on ctx.signal.
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

          const writer = makeWriter(vault);
          try {
            // 2. Router.
            const routerOut = await router(
              { article, body, refs: articleRefs },
              toolsClients,
              signal,
            );

            // 3. Fan-out scouts in parallel.
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

            // 4. Reviewer.
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

            // 5. Reconcile + gate.
            const topicPaths = await vault.list('wiki/topics/*.md');
            const existingTopicSlugs = new Set(
              topicPaths.map((p) => basename(p, '.md')),
            );
            const gated = await applyReconcileAndGate({
              reviewer: reviewerOut,
              existingTopicSlugs,
              sourceExists: (filename) => vault.exists(`wiki/sources/${filename}.md`),
              entityExists: (slug) => vault.exists(`wiki/entities/${slug}.md`),
            });

            // 6. Summary. Truncation throws → caught by outer try; rollback.
            const summary = await summarizer(
              { article, body },
              { client: clients.summaryClient, model: clients.summaryModel },
              signal,
            );

            // 7. Deterministic writes.
            const memberEntry = {
              filename: sourceFilename,
              title: article.title,
              collected: article.collectedAt,
            };

            // 7a. Source page.
            const sourceContent = formatSourcePage({
              stableId: sid,
              url: article.url ?? '',
              arxivId: sid.kind === 'arxiv' ? sid.id : undefined,
              doi: sid.kind === 'doi' ? sid.doi : undefined,
              sourceName: article.source,
              collected: article.collectedAt,
              title: article.title,
              field: article.field,
              topics: gated.existingTopicSlugs,
              cites: gated.citeFilenames,
              summary,
            });
            await writer.write(sourcePath, sourceContent);

            // 7b. Topic-page touches: existing → appendMemberSource, new → create.
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
                continue; // existing-topic slug but page absent; skip
              }
              topicPagePaths.push(topicPath);
            }

            // 7c. Backlinks: cited source pages + entity pages.
            const backlinkPagePaths: string[] = [];
            const backlinkOn = async (path: string): Promise<void> => {
              if (!(await vault.exists(path))) return;
              const existing = await vault.read(path);
              const updated = appendCitedBy(existing, {
                filename: sourceFilename,
                title: article.title,
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

            // 8. markDone with the full audit trail.
            const allPaths = [sourcePath, ...topicPagePaths, ...backlinkPagePaths];
            store.markDone(article.id, allPaths);

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
              articleId: article.id,
              outcome: 'done',
              sourcePagePath: sourcePath,
              topicPagePaths,
              backlinkPagePaths,
              logEntry: `[${ts}] ingest-v3 | ${article.title.slice(0, 80)} → ${slugSummary}${gateNote}`,
            };
          } catch (err) {
            // Roll back any partial writes before re-throwing into the
            // boundedFanout's collect mode.
            await writer.rollback();
            throw err;
          } finally {
            releaseParentListener();
          }
        },
      });

      // Map FanOutResult<ArticleResult>[] → ArticleResult[]. Synthetic
      // AbortError on a per-article runner = soft deadline rolled it over.
      ctx.results = fanoutResults.map((r, i) => {
        if (r.ok) return r.value;
        const a = batch[i]!;
        if (r.error.name === 'AbortError') {
          store.markPending(a.id);
          return {
            articleId: a.id,
            outcome: 'skipped',
            reason: 'deadline-rolled-over',
            topicPagePaths: [],
            backlinkPagePaths: [],
          };
        }
        store.markFailed(a.id, r.error.message.slice(0, 200));
        return {
          articleId: a.id,
          outcome: 'failed',
          reason: r.error.message.slice(0, 200),
          topicPagePaths: [],
          backlinkPagePaths: [],
        };
      });

      const tally = ctx.results.reduce(
        (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
        { done: 0, skipped: 0, failed: 0 } as Record<string, number>,
      );
      yield {
        type: 'phase',
        phase: 'per-article-tree',
        detail: `done=${tally.done} skipped=${tally.skipped} failed=${tally.failed}`,
        counts: tally,
      };
    },
  });

// ---------------------------------------------------------------------------
// mergeMetadata — append per-article logEntries to log.md. index.md is not
// maintained per-article (separate lint).
// ---------------------------------------------------------------------------

export const mergeMetadata = (vault: VaultFs): Phase<LibrarianCtx> => ({
  name: 'merge-metadata',
  async *run(ctx) {
    const results = requireCtx(ctx, 'results', 'merge-metadata');
    const logEntries = results.map((r) => r.logEntry).filter((e): e is string => Boolean(e));
    if (logEntries.length > 0) {
      const block = logEntries.map((e) => `## ${e.replace(/^## ?/, '')}`).join('\n\n');
      await vault.append('log.md', '\n' + block + '\n');
    }
    yield {
      type: 'phase',
      phase: 'merge-metadata',
      detail: `${logEntries.length} log entries`,
      counts: { log: logEntries.length },
    };
  },
});

// ---------------------------------------------------------------------------
// commitLocal — single local commit per run, scoped to source/topic/log paths.
// ---------------------------------------------------------------------------

export const commitLocal = (git: GitOps): Phase<LibrarianCtx> => ({
  name: 'commit-local',
  async *run(ctx) {
    const results = requireCtx(ctx, 'results', 'commit-local');
    const tally = results.reduce(
      (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
      { done: 0, skipped: 0, failed: 0 } as Record<string, number>,
    );
    const message = `ingest: ${results.length} articles (${tally.done} done, ${tally.skipped} skipped, ${tally.failed} failed)`;
    const result = await git.commit(message, ['log.md', 'wiki/sources/', 'wiki/topics/']);
    yield {
      type: 'agent_activity',
      agent: 'commit-local',
      action: result.committed ? 'committed' : 'noop',
      detail: result.committed
        ? `${result.sha?.slice(0, 7)} — ${message}`
        : 'no changes to commit',
    };
  },
});

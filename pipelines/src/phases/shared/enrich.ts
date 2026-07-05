/**
 * Shared enrich phase — the full-text ladder policy.
 *
 * For each pending article, try candidate URLs in order of expected text
 * quality, stopping as soon as we have enough:
 *
 *   1. arXiv native HTML (arxiv.org/html/{id}) when the article is an
 *      arXiv paper — real full text for most post-2023 submissions.
 *   2. The article's own URL.
 *   3. Unpaywall OA copy when the article has a DOI and neither of the
 *      above yielded enough text (author preprint / PMC / repository).
 *
 * Outcome semantics:
 *   - text ≥ ACCEPT_MIN_CHARS       → markEnriched (with refs extracted)
 *   - all rungs failed, non-retryable → markEnrichFailed (summarizer falls
 *                                       back to the abstract)
 *   - every failure retryable (network blip, 5xx) → row stays 'pending'
 *     and the next cycle retries. A persistently-5xx URL retries forever,
 *     which is harmless at our batch sizes but worth knowing.
 *
 * Transitions happen only on completion — a crash mid-phase leaves rows
 * 'pending', which is exactly the recovery behavior we want.
 */

import type { Phase } from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';

import type { SharedPipelineCtx } from '../../shared/shared-pipeline-types.js';
import type { SharedArticleRow, SharedArticleStore } from '../../shared/shared-article-store.js';
import { fetchDocumentText, type FetchDocumentResult } from '../../shared/fulltext.js';
import { resolveOa, type UnpaywallResult } from '../../shared/unpaywall.js';
import { extractArxivIds, extractDois } from '../../shared/refs.js';
import { stableIdForUrl } from '../page-templates.js';

/** Below this, a fetch result isn't worth calling full text at all. */
export const ACCEPT_MIN_CHARS = 500;
/** At or above this, stop climbing the ladder — we have real full text. */
export const GOOD_ENOUGH_CHARS = 6000;

const ENRICH_CONCURRENCY = 4;
const ENRICH_BATCH = 30;

export interface EnrichDeps {
  /** Injectable for tests; defaults to the real implementations. */
  fetchDoc?: typeof fetchDocumentText;
  resolveOaFn?: typeof resolveOa;
  /** Contact email for Unpaywall; the OA rung is skipped when null. */
  unpaywallEmail: string | null;
}

export interface EnrichOutcome {
  stableId: string;
  outcome: 'enriched' | 'enrich-failed' | 'retry-later';
  /** Present on 'enriched'. */
  text?: string;
  refsArxiv?: string[];
  refsDoi?: string[];
  /** Which ladder rung produced the text (telemetry). */
  via?: 'arxiv-html' | 'direct' | 'unpaywall';
  reason?: string;
}

/**
 * Candidate URLs in ladder order, derived purely from the article's URL.
 * arXiv articles get the native-HTML rung prepended; everything else just
 * tries its own URL. The Unpaywall rung is separate (needs an async lookup).
 */
export function candidateUrls(articleUrl: string): Array<{ url: string; via: 'arxiv-html' | 'direct' }> {
  const sid = stableIdForUrl(articleUrl);
  if (sid?.kind === 'arxiv') {
    return [
      { url: `https://arxiv.org/html/${sid.id}`, via: 'arxiv-html' },
      { url: articleUrl, via: 'direct' },
    ];
  }
  return [{ url: articleUrl, via: 'direct' }];
}

/** The article's own DOI, when its URL is a DOI link. Used for the OA rung. */
export function articleDoi(articleUrl: string): string | null {
  const sid = stableIdForUrl(articleUrl);
  return sid?.kind === 'doi' ? sid.doi : null;
}

export async function enrichOne(
  article: SharedArticleRow,
  deps: EnrichDeps,
  signal?: AbortSignal,
): Promise<EnrichOutcome> {
  const fetchDoc = deps.fetchDoc ?? fetchDocumentText;
  const resolveOaFn = deps.resolveOaFn ?? resolveOa;

  let best: { text: string; via: 'arxiv-html' | 'direct' | 'unpaywall' } | null = null;
  let sawNonRetryable = false;
  const failures: string[] = [];

  const consider = (result: FetchDocumentResult, via: 'arxiv-html' | 'direct' | 'unpaywall'): void => {
    if (result.ok) {
      if (!best || result.text.length > best.text.length) best = { text: result.text, via };
    } else {
      failures.push(`${via}: ${result.reason}`);
      if (!result.retryable) sawNonRetryable = true;
    }
  };

  for (const candidate of candidateUrls(article.url)) {
    if (signal?.aborted) break;
    consider(await fetchDoc(candidate.url, { signal }), candidate.via);
    if (best !== null && (best as { text: string }).text.length >= GOOD_ENOUGH_CHARS) break;
  }

  // Unpaywall rung: only when we still lack good text AND we can identify a DOI.
  const currentLen = best === null ? 0 : (best as { text: string }).text.length;
  if (currentLen < GOOD_ENOUGH_CHARS && deps.unpaywallEmail && !signal?.aborted) {
    const doi = articleDoi(article.url);
    if (doi) {
      const oa: UnpaywallResult = await resolveOaFn(doi, deps.unpaywallEmail, { signal });
      if (oa.status === 'oa') {
        consider(await fetchDoc(oa.location.url, { signal }), 'unpaywall');
      } else if (oa.status === 'error') {
        failures.push(`unpaywall: ${oa.reason}`);
      }
      // 'closed' / 'not-found' are conclusive non-answers, not failures.
    }
  }

  if (best !== null) {
    const accepted = best as { text: string; via: 'arxiv-html' | 'direct' | 'unpaywall' };
    if (accepted.text.length >= ACCEPT_MIN_CHARS) {
      return {
        stableId: article.stableId,
        outcome: 'enriched',
        text: accepted.text,
        refsArxiv: extractArxivIds(accepted.text),
        refsDoi: extractDois(accepted.text),
        via: accepted.via,
      };
    }
    failures.push(`best text too short (${accepted.text.length} chars)`);
    sawNonRetryable = true;
  }

  const reason = failures.slice(0, 3).join('; ') || 'no fetchable candidates';
  return sawNonRetryable || failures.length === 0
    ? { stableId: article.stableId, outcome: 'enrich-failed', reason }
    : { stableId: article.stableId, outcome: 'retry-later', reason };
}

export const enrichPending = (
  store: SharedArticleStore,
  deps: EnrichDeps,
  batchSize: number = ENRICH_BATCH,
): Phase<SharedPipelineCtx> => ({
  name: 'shared-enrich',
  async *run(ctx) {
    const batch = store.listByStatus('pending', batchSize);
    if (batch.length === 0) {
      ctx.enrichCounts = { enriched: 0, enrichFailed: 0, retryLater: 0 };
      yield { type: 'phase', phase: 'shared-enrich', detail: 'nothing pending' };
      return;
    }

    const results = await boundedFanout({
      items: batch,
      concurrency: ENRICH_CONCURRENCY,
      mode: 'collect' as const,
      signal: ctx.signal,
      runner: (article) => enrichOne(article, deps, ctx.signal),
    });

    const outcomes: EnrichOutcome[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const article = batch[i]!;
      const outcome: EnrichOutcome = r.ok
        ? r.value
        : {
            stableId: article.stableId,
            outcome: 'retry-later',
            reason: r.error.message.slice(0, 200),
          };
      outcomes.push(outcome);

      if (outcome.outcome === 'enriched') {
        store.markEnriched(
          outcome.stableId,
          outcome.text!,
          outcome.refsArxiv ?? [],
          outcome.refsDoi ?? [],
        );
      } else if (outcome.outcome === 'enrich-failed') {
        store.markEnrichFailed(outcome.stableId, outcome.reason ?? 'unknown');
      }
      // 'retry-later' → no transition; row stays pending for the next cycle.
    }

    const tally = outcomes.reduce(
      (acc, o) => {
        if (o.outcome === 'enriched') acc.enriched += 1;
        else if (o.outcome === 'enrich-failed') acc.enrichFailed += 1;
        else acc.retryLater += 1;
        return acc;
      },
      { enriched: 0, enrichFailed: 0, retryLater: 0 },
    );
    ctx.enrichCounts = tally;
    yield {
      type: 'phase',
      phase: 'shared-enrich',
      detail: `enriched=${tally.enriched} failed=${tally.enrichFailed} retry=${tally.retryLater}`,
      counts: tally,
    };
  },
});

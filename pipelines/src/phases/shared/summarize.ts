/**
 * Shared summarize phase — one rich summary per article, computed once
 * regardless of how many users the article later routes to.
 *
 * Consumes rows in 'enriched' (full text) or 'enrich-failed' (abstract
 * fallback). Rows with neither text nor abstract are marked failed.
 *
 * The output contract is structured markdown the whole system leans on:
 * per-user librarians embed it in source pages, the digest pulls
 * `## Findings` for email TL;DRs, and the routing layer embeds the whole
 * thing. Change the section names only with a migration plan.
 */

import { runAgentWithTools, type Phase } from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';

import type { SharedPipelineCtx } from '../../shared/shared-pipeline-types.js';
import {
  isTransientFailureReason,
  type QualityAssessment,
  type SharedArticleRow,
  type SharedArticleStore,
} from '../../shared/shared-article-store.js';

const SUMMARIZE_CONCURRENCY = 4;
const SUMMARIZE_BATCH = 20;

/** Transient failures leave the row retryable until this many attempts. */
const MAX_SUMMARIZE_ATTEMPTS = 3;

/** Prompt-input cap. qwen36's window is 131K; this is latency discipline,
 *  not necessity. ~10K tokens of source text. */
const INPUT_CAP_CHARS = 40_000;

const SUMMARY_SYSTEM = `You are a research-article summarizer for a personal research library.

Write a structured summary in markdown with EXACTLY these section headings, in this order, omitting any section that does not apply to the article:

## Overview
2-3 sentences: the problem addressed and the approach taken.

## Methods
2-4 sentences: how the work was done — techniques, models, experimental setup, theoretical tools. Omit for pure announcements or opinion pieces.

## Data
1-3 sentences: datasets, sample sizes, benchmarks, or data sources used. Omit if the article uses no data.

## Findings
2-4 sentences: the concrete results and their magnitudes. Prefer numbers over adjectives.

## Significance
1-2 sentences: why this matters or what it changes. Omit if unclear.

## Assessment
ALWAYS include this section, last, with exactly these three lines and nothing else:
rigor: N/5
evidence: N/5
kind: research|survey|position|announcement|other

Scoring guide — rigor: 1 = not actual research (ad, listicle, empty shell), 3 = plausible methodology with gaps, 5 = rigorous and complete. evidence: 1 = claims without support, 3 = partial experiments/proofs, 5 = thorough validation. kind: 'research' for original work, 'survey' for reviews, 'position' for opinion/argument pieces, 'announcement' for releases/news, 'other' if none fit. Judge only from the text given; abstract-only inputs cap evidence at 3.

Rules:
- Total length 150-300 words (excluding the Assessment section). Concise beats complete.
- Plain prose inside each section. No bullet lists, no nested headings, no links, no citations.
- Present tense ("the paper proposes", "the authors show").
- Do not invent facts. If the source text is thin (e.g., abstract only), write fewer, shorter sections rather than padding.
- No preamble or postscript — start directly with "## Overview".`;

export interface SummarizeClients {
  client: OpenAI;
  model: string;
}

// ---------------------------------------------------------------------------
// Assessment parsing + the quality gate
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set(['research', 'survey', 'position', 'announcement', 'other']);

export interface ParsedSummary {
  /** Summary with the ## Assessment section stripped. */
  summary: string;
  /** null when the section was missing or malformed — callers fail OPEN. */
  quality: QualityAssessment | null;
}

/**
 * Split the summarizer's output into the user-facing summary and the parsed
 * quality assessment. Tolerant of field order and surrounding noise inside
 * the section; strict about value shapes. A missing or malformed section
 * yields quality=null — the pipeline treats unassessed as passing (a broken
 * rubric must never silently starve the vaults).
 */
export function parseSummaryOutput(text: string): ParsedSummary {
  const marker = /^## Assessment\s*$/m.exec(text);
  if (!marker) return { summary: text.trim(), quality: null };

  const summary = text.slice(0, marker.index).trim();
  const section = text.slice(marker.index + marker[0].length);

  const rigor = /^\s*rigor:\s*([1-5])\s*\/\s*5\s*$/m.exec(section);
  const evidence = /^\s*evidence:\s*([1-5])\s*\/\s*5\s*$/m.exec(section);
  const kind = /^\s*kind:\s*([a-z]+)\s*$/m.exec(section);

  if (!rigor || !evidence || !kind || !VALID_KINDS.has(kind[1]!)) {
    return { summary, quality: null };
  }
  return {
    summary,
    quality: {
      rigor: Number(rigor[1]),
      evidence: Number(evidence[1]),
      kind: kind[1] as QualityAssessment['kind'],
    },
  };
}

/**
 * The vault-entry quality floor. Deliberately conservative — it exists to
 * drop clear junk (ads, releases, empty shells), not to judge weak-but-real
 * research; the digest is where attention gets defended. Every assessment
 * is stored either way, so this floor gets tuned from accumulated data
 * (`SELECT quality_kind, quality_rigor, COUNT(*) ... GROUP BY`), not
 * intuition.
 */
export function failsQualityGate(quality: QualityAssessment | null): boolean {
  if (quality === null) return false; // fail-open: unassessed passes
  if (quality.kind === 'announcement' || quality.kind === 'other') return true;
  return quality.rigor <= 1;
}

export type SharedSummarizer = (
  article: SharedArticleRow,
  clients: SummarizeClients,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * One fast-tier LLM call, no tools. Throws on truncation so the phase's
 * collect-mode fan-out records the row as failed rather than storing a
 * cut-off summary.
 */
export const callRichSummary: SharedSummarizer = async (article, clients, signal) => {
  const sourceText = article.fulltext ?? article.abstract ?? '';
  const basis = article.fulltext ? 'full text' : 'abstract only';
  const r = await runAgentWithTools(
    {
      name: 'shared-summarize',
      systemPrompt: SUMMARY_SYSTEM,
      model: clients.model,
      tools: [],
      maxToolRounds: 1,
      // Well past any sane summary; only genuine runaway output trips the
      // truncation backstop below.
      maxTokens: 8000,
    },
    [
      {
        role: 'user',
        content:
          `Title: ${article.title}\n` +
          `Source: ${article.source ?? '(unknown)'}\n` +
          `Available text: ${basis}\n\n` +
          `${sourceText.slice(0, INPUT_CAP_CHARS)}`,
      },
    ],
    {
      client: clients.client,
      toolExecutor: { execute: async () => ({ toolCallId: '', content: '' }) },
      signal,
    },
  );
  if (r.finishReason === 'length') {
    throw new Error('summary truncated: model exhausted its output budget');
  }
  const text = r.text.trim();
  if (!text.startsWith('## ')) {
    throw new Error(`summary missing section structure (starts: ${text.slice(0, 60)})`);
  }
  return text;
};

export const summarizeEnriched = (
  store: SharedArticleStore,
  clients: SummarizeClients,
  summarizer: SharedSummarizer = callRichSummary,
  batchSize: number = SUMMARIZE_BATCH,
): Phase<SharedPipelineCtx> => ({
  name: 'shared-summarize',
  async *run(ctx) {
    // enrich-failed rows still summarize (from the abstract) — degraded but
    // useful. Split the batch across both statuses, full-text rows first.
    const enriched = store.listByStatus('enriched', batchSize);
    const fallback = store.listByStatus('enrich-failed', Math.max(0, batchSize - enriched.length));
    const batch = [...enriched, ...fallback];

    if (batch.length === 0) {
      ctx.summarizeCounts = { summarized: 0, failed: 0, noText: 0, rejected: 0, retryLater: 0 };
      yield { type: 'phase', phase: 'shared-summarize', detail: 'nothing to summarize' };
      return;
    }

    let summarized = 0;
    let failed = 0;
    let noText = 0;
    let rejected = 0;
    let retryLater = 0;

    const results = await boundedFanout({
      items: batch,
      concurrency: SUMMARIZE_CONCURRENCY,
      mode: 'collect' as const,
      signal: ctx.signal,
      runner: async (article) => {
        if (!article.fulltext && !article.abstract) return null;
        return summarizer(article, clients, ctx.signal);
      },
    });

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const article = batch[i]!;
      if (!r.ok) {
        // Aborts (deadline) leave the row in place for the next cycle
        // without consuming an attempt. Transient faults (network/provider
        // errors, including the LLM layer's {"_error":true} text payloads)
        // also leave the status untouched so the next tick retries — up to
        // the attempt cap, after which they fail for real. Everything else
        // (structure violations, non-retryable 4xx) is terminal.
        if (r.error.name !== 'AbortError') {
          const attempts = store.incrementSummarizeAttempts(article.stableId);
          if (isTransientFailureReason(r.error.message) && attempts < MAX_SUMMARIZE_ATTEMPTS) {
            retryLater++;
          } else {
            store.markFailed(article.stableId, `summarize: ${r.error.message.slice(0, 200)}`);
            failed++;
          }
        }
        continue;
      }
      if (r.value === null) {
        store.markFailed(article.stableId, 'no-text: neither fulltext nor abstract');
        noText++;
        continue;
      }
      const { summary, quality } = parseSummaryOutput(r.value);
      if (failsQualityGate(quality)) {
        // Assessment + summary are stored anyway — the floor gets tuned from
        // this data, and a wrongly-rejected article can be re-queued.
        store.markRejectedQuality(article.stableId, summary, quality!);
        rejected++;
        continue;
      }
      store.markSummarized(article.stableId, summary, quality);
      summarized++;
    }

    ctx.summarizeCounts = { summarized, failed, noText, rejected, retryLater };
    yield {
      type: 'phase',
      phase: 'shared-summarize',
      detail: `summarized=${summarized} rejected=${rejected} failed=${failed} no-text=${noText} retry-later=${retryLater}`,
      counts: { summarized, rejected, failed, noText, retryLater },
    };
  },
});

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
import type { SharedArticleRow, SharedArticleStore } from '../../shared/shared-article-store.js';

const SUMMARIZE_CONCURRENCY = 4;
const SUMMARIZE_BATCH = 20;

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

Rules:
- Total length 150-300 words. Concise beats complete.
- Plain prose inside each section. No bullet lists, no nested headings, no links, no citations.
- Present tense ("the paper proposes", "the authors show").
- Do not invent facts. If the source text is thin (e.g., abstract only), write fewer, shorter sections rather than padding.
- No preamble or postscript — start directly with "## Overview".`;

export interface SummarizeClients {
  client: OpenAI;
  model: string;
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
      ctx.summarizeCounts = { summarized: 0, failed: 0, noText: 0 };
      yield { type: 'phase', phase: 'shared-summarize', detail: 'nothing to summarize' };
      return;
    }

    let summarized = 0;
    let failed = 0;
    let noText = 0;

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
        // Aborts (deadline) leave the row in place for the next cycle;
        // real failures are recorded.
        if (r.error.name !== 'AbortError') {
          store.markFailed(article.stableId, `summarize: ${r.error.message.slice(0, 200)}`);
          failed++;
        }
        continue;
      }
      if (r.value === null) {
        store.markFailed(article.stableId, 'no-text: neither fulltext nor abstract');
        noText++;
        continue;
      }
      store.markSummarized(article.stableId, r.value);
      summarized++;
    }

    ctx.summarizeCounts = { summarized, failed, noText };
    yield {
      type: 'phase',
      phase: 'shared-summarize',
      detail: `summarized=${summarized} failed=${failed} no-text=${noText}`,
      counts: { summarized, failed, noText },
    };
  },
});

/**
 * callSummary — the per-article summary LLM call.
 *
 * Single fast no-tool call against the summary tier. Returns a 2-3 paragraph
 * plain-prose summary. Throws on truncation (the only `finishReason === 'length'`
 * path with maxTokens=8000 is the model hitting its own context window —
 * a genuinely runaway summary, not normal length variation).
 */

import { runAgentWithTools } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow } from '../shared/article-store.js';

export interface SummaryInput {
  article: ArticleRow;
  /** Enriched body from batchEnrich (or just the snippet if no fetch). */
  body: string;
}

export interface SummaryClients {
  /** Fast no-tool model. */
  client: OpenAI;
  model: string;
}

export type Summarizer = (
  input: SummaryInput,
  clients: SummaryClients,
  signal?: AbortSignal,
) => Promise<string>;

// Body cap for the user message — the LLM doesn't benefit from arbitrarily long
// bodies for a 2-3 paragraph summary, and it keeps prompt-cache hit rates high.
const BODY_CAP = 8000;

const SUMMARY_SYSTEM = `You are a research-paper summarizer. Given an article's title, source, and body, write a 2-3 paragraph plain-prose summary.

Rules:
- 2 to 3 paragraphs, separated by a blank line. No more.
- Plain prose only. No bullet lists, no markdown headings, no inline citations or links.
- Lead with what the paper IS (problem + approach). Follow with key findings or contributions. Optionally one sentence on context or significance.
- Write in present tense ("the paper proposes", "the authors show").
- No filler ("This is an interesting paper..."). Get to the substance immediately.
- Do not invent facts. If the body is thin, write a shorter summary rather than padding.`;

export async function callSummary(
  input: SummaryInput,
  clients: SummaryClients,
  signal?: AbortSignal,
): Promise<string> {
  const { article, body } = input;
  const r = await runAgentWithTools(
    {
      name: 'write-source-summary',
      systemPrompt: SUMMARY_SYSTEM,
      model: clients.model,
      tools: [],
      maxToolRounds: 1,
      // Effectively no cap. A well-behaved summary is 400-800 tokens; even
      // an overlong one rarely exceeds 1500. Setting this past the model's
      // own context-window (~8K for the fast tier) means only genuine
      // runaway output trips the truncation backstop below, not normal
      // length variation. Local Ollama tokens are free; latency at 8K is
      // bounded by content, not the cap.
      maxTokens: 8000,
    },
    [
      {
        role: 'user',
        content:
          `Title: ${article.title}\n` +
          `Source: ${article.source ?? '(unknown)'}\n` +
          `Field: ${article.field ?? '(unknown)'}\n` +
          `URL: ${article.url ?? '(empty)'}\n\n` +
          `Body:\n${body.slice(0, BODY_CAP)}`,
      },
    ],
    {
      client: clients.client,
      toolExecutor: { execute: async () => ({ toolCallId: '', content: '' }) },
      signal,
    },
  );
  // Truncation backstop: with maxTokens set well past the model's context
  // window, finishReason='length' means the model exhausted its own window
  // before finishing. Fail the article rather than index a cut-off page.
  if (r.finishReason === 'length') {
    throw new Error(
      `write-source summary truncated: model exhausted its context window before finishing.`,
    );
  }
  return r.text.trim();
}

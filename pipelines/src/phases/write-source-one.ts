/**
 * callSummary + writeSourceOne — summary LLM call and (legacy) one-shot
 * source-page writer.
 *
 * The live librarian only consumes callSummary (the per-article fan-out
 * inlines its own write step). writeSourceOne is kept as a self-contained
 * convenience for one-off scripts and tests; both share the same idempotent
 * stable-id check.
 *
 * Two no-op return paths (both null):
 *   - article has no URL → can't form a stable id; caller skips.
 *   - target page already exists on disk → idempotent re-encounter
 *     of a previously ingested article (title-hash dedup misses, url-hash
 *     hits via the stable id). The pre-existing content is preserved.
 */

import { runAgentWithTools } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow } from '../shared/article-store.js';
import type { VaultFs } from '../tools/vault.js';
import { formatSourcePage, stableIdForUrl, stableIdToFilename } from './page-templates.js';

export interface WriteSourceOneInput {
  article: ArticleRow;
  /** Enriched body from batchEnrich (or just the snippet if no fetch). */
  body: string;
  /** Final topic slugs (already reconciled against the existing inventory). */
  topics: string[];
  /** Stable filenames of cited references that resolved in ArticleStore. */
  cites: string[];
}

export interface WriteSourceOneOutput {
  /** Where the source page was written. e.g. 'wiki/sources/arxiv-2605-03823.md'. */
  path: string;
  /** The summary the LLM wrote, for log/event purposes. */
  summary: string;
}

export interface WriteSourceOneClients {
  /** Fast no-tool model for summary writing. */
  client: OpenAI;
  model: string;
}

export type Summarizer = (
  input: WriteSourceOneInput,
  clients: WriteSourceOneClients,
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

/**
 * Generate a 2-3 paragraph plain-prose summary via one fast LLM call (no tools).
 * Throws on truncation (finishReason === 'length') so the caller's
 * mode='collect' fan-out surfaces it as a failed slot.
 */
export async function callSummary(
  input: WriteSourceOneInput,
  clients: WriteSourceOneClients,
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
  // Truncation backstop: with maxTokens unset, the only way finishReason
  // can land as 'length' is the model hitting its own context window. That
  // would mean a genuinely runaway summary; fail the article rather than
  // index a cut-off page.
  if (r.finishReason === 'length') {
    throw new Error(
      `write-source summary truncated: model exhausted its context window before finishing.`,
    );
  }
  return r.text.trim();
}

/**
 * Write a single source page for `input.article`. Steps:
 *   1. Compute the stable ID + filename via stableIdForUrl/stableIdToFilename.
 *   2. Skip and return null if the source page already exists at the target
 *      path (idempotent: the article was already ingested in a prior run).
 *   3. Generate a 2-3 paragraph summary via one fast LLM call (no tools).
 *   4. Format via formatSourcePage and write to vault.
 *   5. Return the path + summary.
 *
 * Returns null when:
 *   - The article has no URL (can't form a stable ID; caller treats as
 *     skipped).
 *   - The source page already exists on disk (already ingested).
 */
export async function writeSourceOne(
  input: WriteSourceOneInput,
  clients: WriteSourceOneClients,
  vault: VaultFs,
  signal?: AbortSignal,
  // Dependency-injected so tests can stub the LLM call without mocking the
  // module loader. Defaults to the real callSummary.
  summarizer: Summarizer = callSummary,
): Promise<WriteSourceOneOutput | null> {
  const stableId = stableIdForUrl(input.article.url ?? '');
  if (!stableId) return null;

  const filename = stableIdToFilename(stableId);
  const path = `wiki/sources/${filename}.md`;

  // Idempotency: a re-encountered article (url-hash matches a row whose
  // title-hash didn't) shouldn't overwrite the existing source page.
  if (await vault.exists(path)) return null;

  const summary = await summarizer(input, clients, signal);

  const content = formatSourcePage({
    stableId,
    url: input.article.url ?? '',
    arxivId: stableId.kind === 'arxiv' ? stableId.id : undefined,
    doi: stableId.kind === 'doi' ? stableId.doi : undefined,
    sourceName: input.article.source,
    collected: input.article.collectedAt,
    title: input.article.title,
    field: input.article.field,
    topics: input.topics,
    cites: input.cites,
    summary,
  });

  await vault.write(path, content);
  return { path, summary };
}

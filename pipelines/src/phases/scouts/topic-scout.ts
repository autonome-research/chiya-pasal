/**
 * topic-scout — one of four parallel exploration scouts in the v3 librarian's
 * per-article fan-out (topic / source / entity / cite). Given an article being
 * indexed, the topic scout explores wiki/topics/ via read-only vault tools and
 * surfaces existing topic pages most relevant to the article.
 *
 * The scout does NOT decide final memberships — its output is a shortlist for
 * the reviewer. Output is deliberately bounded (≤ 5 pages) so the reviewer
 * sees signal, not a vault dump.
 */

import { parseJSON, runAgentWithTools, ToolRegistry } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow } from '../../shared/article-store.js';
import { registerReadOnlyVaultTools, type VaultFs } from '../../tools/vault.js';
import type { ScoutOutput, SurfacedPage } from './types.js';

export interface TopicScoutInput {
  article: ArticleRow;
  /** Enriched full-text body if available, else the snippet. */
  body: string;
  /** Per-article task from the librarian-router (1-3 sentences telling the
   *  scout what to look for). May be empty for a default-prompt run. */
  task: string;
}

export interface TopicScoutClients {
  client: OpenAI;
  model: string;
}

export type TopicScoutRunner = (
  input: TopicScoutInput,
  clients: TopicScoutClients,
  vault: VaultFs,
  signal?: AbortSignal,
) => Promise<ScoutOutput>;

/**
 * Dependency-injected agent invocation. Lets tests bypass runAgentWithTools and
 * supply canned outputs (text, finishReason, toolRounds) without faking an
 * OpenAI stream. Defaults to the real runAgentWithTools-backed implementation.
 */
export type ScoutAgentFn = (
  systemPrompt: string,
  userMessage: string,
  registry: ToolRegistry,
  clients: TopicScoutClients,
  signal?: AbortSignal,
) => Promise<{ text: string; finishReason: string; toolRounds: number }>;

// Body cap for the user message — the scout's prompt-cache hit rate matters
// across the four parallel scouts; a fixed cap keeps the prefix stable.
const BODY_CAP = 8000;
const MAX_TOOL_ROUNDS = 10;
const MAX_TOKENS = 2000;
const MAX_SURFACED_PAGES = 5;

const SYSTEM_PROMPT = `You are the wiki TOPIC-SCOUT for the chiya research library.

Your job: given a research article being indexed, explore wiki/topics/ via tools and surface the EXISTING topic pages most relevant to this article. You do NOT decide final memberships — that's the reviewer's job. Your output is a shortlist for the reviewer to consider.

TOOLS:
- vault_list(pattern)         — list paths, e.g. vault_list("wiki/topics/*.md")
- vault_search_by_keyword     — grep keyword across files
- vault_read(path)            — read a file

PROCESS:
1. Read the article title + body. Identify the 2-3 most central concepts.
2. Use vault_search_by_keyword on those concepts (pattern "wiki/topics/*.md") to find candidate pages. Multiple keywords = multiple searches.
3. For the top 3-6 candidates, vault_read the page to verify fit. Read the page's definition (first paragraph after H1) and "## Member sources" to gauge whether THIS article would be at home there.
4. Surface the pages that are clearly relevant. Empty list is a valid answer if nothing fits.

RESTRAINT:
- Surface at most 5 pages. Quality over quantity. The reviewer will narrow further.
- Do not surface a page just because it shares a generic word ("ai", "model"). Match on substance, not jargon.
- Do not invent paths. Only paths you actually read with vault_read may appear in output.

OUTPUT (JSON only, no preamble, no code fences):
{
  "surfacedPages": [
    {
      "path": "wiki/topics/llm-evaluation.md",
      "excerpt": "≤400 char quote or paraphrase from the page",
      "relevanceNote": "1-sentence why this article would fit here"
    }
  ]
}`;

function formatUserMessage(input: TopicScoutInput): string {
  const { article, body, task } = input;
  const taskLine = task.trim().length > 0
    ? task.trim()
    : 'Find existing topic pages relevant to this article.';
  return (
    `Article title: ${article.title}\n` +
    `Article URL: ${article.url ?? '(empty)'}\n` +
    `Article field tag (often unreliable, ignore if it disagrees with the body): ${article.field ?? '(unknown)'}\n\n` +
    `Article body (capped at ${BODY_CAP} chars):\n${body.slice(0, BODY_CAP)}\n\n` +
    `Librarian's task for you:\n${taskLine}`
  );
}

/** Real agent invocation — runs the runAgentWithTools loop with the scout's
 *  read-only vault tools and returns just the fields the scout cares about. */
const defaultAgentFn: ScoutAgentFn = async (
  systemPrompt,
  userMessage,
  registry,
  clients,
  signal,
) => {
  const r = await runAgentWithTools(
    {
      name: 'topic-scout',
      systemPrompt,
      model: clients.model,
      tools: registry.definitions(),
      maxToolRounds: MAX_TOOL_ROUNDS,
      maxTokens: MAX_TOKENS,
    },
    [{ role: 'user', content: userMessage }],
    {
      client: clients.client,
      toolExecutor: registry,
      signal,
    },
  );
  return {
    text: r.text,
    finishReason: r.finishReason,
    toolRounds: r.executedToolCalls.length,
  };
};

/**
 * Core scout runner with an injectable agent function. The public
 * `runTopicScout` calls this with `defaultAgentFn`; tests pass their own
 * agentFn to control the LLM result without faking an OpenAI stream.
 */
export async function runTopicScoutWith(
  input: TopicScoutInput,
  clients: TopicScoutClients,
  vault: VaultFs,
  signal: AbortSignal | undefined,
  agentFn: ScoutAgentFn,
): Promise<ScoutOutput> {
  const registry = new ToolRegistry();
  registerReadOnlyVaultTools(registry, vault);

  const userMessage = formatUserMessage(input);

  let r: { text: string; finishReason: string; toolRounds: number };
  try {
    r = await agentFn(SYSTEM_PROMPT, userMessage, registry, clients, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { surfacedPages: [], error: msg.slice(0, 200) };
  }

  // Truncation: a 'length' finishReason means the JSON is almost certainly
  // partial. Surface the empty-with-error result so the reviewer can still
  // get information from the other three scouts.
  if (r.finishReason === 'length') {
    return { surfacedPages: [], error: 'truncated', toolRounds: r.toolRounds };
  }

  // We need to distinguish "agent legitimately returned []" from "agent
  // returned non-JSON and parseJSON silently fell back." parseJSON's onError
  // hook fires only on the second case; capture it here.
  let parseFailed = false;
  const fallback: { surfacedPages: SurfacedPage[] } = { surfacedPages: [] };
  const parsed = parseJSON<{ surfacedPages?: SurfacedPage[] }>(r.text, fallback, () => {
    parseFailed = true;
  });

  if (parseFailed || !Array.isArray(parsed.surfacedPages)) {
    return { surfacedPages: [], error: 'parse-failed', toolRounds: r.toolRounds };
  }

  // Sanitize: drop entries missing required fields, cap to MAX_SURFACED_PAGES.
  const cleaned: SurfacedPage[] = [];
  for (const p of parsed.surfacedPages) {
    if (!p || typeof p.path !== 'string' || typeof p.excerpt !== 'string' || typeof p.relevanceNote !== 'string') {
      continue;
    }
    cleaned.push({ path: p.path, excerpt: p.excerpt, relevanceNote: p.relevanceNote });
    if (cleaned.length >= MAX_SURFACED_PAGES) break;
  }

  return { surfacedPages: cleaned, toolRounds: r.toolRounds };
}

/** Real implementation — runAgentWithTools loop with the scout's read-only
 *  vault tools. */
export const runTopicScout: TopicScoutRunner = (input, clients, vault, signal) =>
  runTopicScoutWith(input, clients, vault, signal, defaultAgentFn);

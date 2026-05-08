/**
 * librarianRouter — first LLM call in the v3 per-article flow.
 *
 * Reads the article and writes per-scope task instructions for the four
 * fan-out scouts (topic / source / entity / cite). Each task is 1-3
 * sentences telling that scout what to look for in THIS article — the
 * fixed scope (which dir to explore) is baked into the scout itself.
 *
 * Single LLM call, no tools. Cheap. The scouts then run in parallel.
 */

import { parseJSON, runAgentWithTools } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow } from '../shared/article-store.js';
import type { ExtractedRefs } from '../shared/librarian-v2-types.js';

export interface RouterInput {
  article: ArticleRow;
  /** Enriched body (full text from web fetch) or original snippet. */
  body: string;
  /** Refs already extracted upstream by batchExtractRefs. */
  refs: ExtractedRefs;
}

export interface RouterClients {
  client: OpenAI;
  model: string;
}

export interface RouterOutput {
  topicScoutTask: string;
  sourceScoutTask: string;
  entityScoutTask: string;
  citeTrackerTask: string;
  /** Set if the LLM call truncated or parsing failed. The runner falls
   *  back to default tasks for each scout in that case. */
  error?: string;
}

/** Default tasks used when the router fails or returns empty strings.
 *  Generic enough that a scout can still do useful work. */
const DEFAULT_TASKS: Omit<RouterOutput, 'error'> = {
  topicScoutTask: 'Find existing topic pages relevant to this article.',
  sourceScoutTask: 'Find existing source pages this article is most plausibly related to.',
  entityScoutTask: 'Find existing entity pages (people, organizations, products) the article references.',
  citeTrackerTask: 'Assess each candidate cite\'s relationship to the article. Skip passing mentions.',
};

const ROUTER_SYSTEM = `You are the LIBRARIAN ROUTER for the chiya research wiki.

Your job: read an incoming research article and write 1-3 sentence task instructions for each of four fan-out scouts that will explore the wiki in parallel. Each scout has a fixed scope; your task tells it what to focus on FOR THIS ARTICLE.

Scout scopes:
- topic-scout    — explores wiki/topics/    (subject-area pages: e.g. "llm-evaluation", "quantum-computing")
- source-scout   — explores wiki/sources/   (per-article pages from the corpus)
- entity-scout   — explores wiki/entities/  (people, organizations, products)
- cite-tracker   — looks up the article's references in the library

Write a TARGETED task for each scout. Examples of GOOD tasks:
  topic-scout:    "Look for topic pages on Bayesian consistency, statistical learning theory, and metric losses."
  source-scout:   "Find sibling source pages on PAC-Bayes bounds or universal consistency proofs."
  entity-scout:   "Check if there are pages for the authors (e.g., Bousquet) or relevant labs."
  cite-tracker:   "Pay attention to whether cites are foundational vs background."

Examples of BAD tasks (too generic, no value over the default):
  topic-scout:    "Find relevant topics."
  source-scout:   "Find related sources."

OUTPUT (JSON only, no preamble, no code fences):
{
  "topicScoutTask":   "string, 1-3 sentences",
  "sourceScoutTask":  "string, 1-3 sentences",
  "entityScoutTask":  "string, 1-3 sentences",
  "citeTrackerTask":  "string, 1-3 sentences"
}`;

/**
 * Injection seam for tests: stub the LLM call without faking OpenAI streams.
 * Mirrors the ScoutAgentFn pattern in src/phases/scouts/*.ts.
 */
export type RouterAgentFn = (
  systemPrompt: string,
  userMessage: string,
  clients: RouterClients,
  signal?: AbortSignal,
) => Promise<{ text: string; finishReason: string }>;

const defaultAgentFn: RouterAgentFn = async (systemPrompt, userMessage, clients, signal) => {
  const r = await runAgentWithTools(
    {
      name: 'librarian-router',
      systemPrompt,
      model: clients.model,
      tools: [],
      maxToolRounds: 1,
      maxTokens: 800,
    },
    [{ role: 'user', content: userMessage }],
    {
      client: clients.client,
      toolExecutor: { execute: async () => ({ toolCallId: '', content: '' }) },
      signal,
    },
  );
  return { text: r.text, finishReason: r.finishReason };
};

const BODY_CAP = 4000;

function buildUserMessage(input: RouterInput): string {
  const refsLine =
    input.refs.arxivIds.length === 0 && input.refs.dois.length === 0
      ? '(no extracted refs)'
      : [
          input.refs.arxivIds.length > 0 ? `arxiv: ${input.refs.arxivIds.slice(0, 8).join(', ')}` : null,
          input.refs.dois.length > 0 ? `doi: ${input.refs.dois.slice(0, 8).join(', ')}` : null,
        ].filter(Boolean).join('  ');
  return (
    `Article title: ${input.article.title}\n` +
    `URL: ${input.article.url ?? '(empty)'}\n` +
    `Field tag (often unreliable): ${input.article.field ?? '(unknown)'}\n` +
    `Extracted refs: ${refsLine}\n\n` +
    `Body excerpt (capped at ${BODY_CAP} chars):\n${input.body.slice(0, BODY_CAP)}`
  );
}

function withDefaults(parsed: Partial<RouterOutput>): Omit<RouterOutput, 'error'> {
  return {
    topicScoutTask: (parsed.topicScoutTask ?? '').trim() || DEFAULT_TASKS.topicScoutTask,
    sourceScoutTask: (parsed.sourceScoutTask ?? '').trim() || DEFAULT_TASKS.sourceScoutTask,
    entityScoutTask: (parsed.entityScoutTask ?? '').trim() || DEFAULT_TASKS.entityScoutTask,
    citeTrackerTask: (parsed.citeTrackerTask ?? '').trim() || DEFAULT_TASKS.citeTrackerTask,
  };
}

export async function runRouterWith(
  input: RouterInput,
  clients: RouterClients,
  signal: AbortSignal | undefined,
  agentFn: RouterAgentFn,
): Promise<RouterOutput> {
  const userMessage = buildUserMessage(input);
  let r: { text: string; finishReason: string };
  try {
    r = await agentFn(ROUTER_SYSTEM, userMessage, clients, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...DEFAULT_TASKS, error: msg.slice(0, 200) };
  }
  if (r.finishReason === 'length') {
    return { ...DEFAULT_TASKS, error: 'truncated' };
  }
  let parseFailed = false;
  const parsed = parseJSON<Partial<RouterOutput>>(r.text, {}, () => { parseFailed = true; });
  if (parseFailed) {
    return { ...DEFAULT_TASKS, error: 'parse-failed' };
  }
  return withDefaults(parsed);
}

export type RouterRunner = (
  input: RouterInput,
  clients: RouterClients,
  signal?: AbortSignal,
) => Promise<RouterOutput>;

export const runRouter: RouterRunner = (input, clients, signal) =>
  runRouterWith(input, clients, signal, defaultAgentFn);

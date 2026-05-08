/**
 * entity-scout — one of four parallel exploration scouts in the v3 librarian's
 * per-article fan-out (topic / source / entity / cite). Given an article being
 * indexed, the entity scout explores wiki/entities/ via read-only vault tools
 * and surfaces existing entity pages (people, organizations, products, tools)
 * the article meaningfully references.
 *
 * The scout does NOT decide final backlinks — its output is a shortlist for
 * the reviewer. Output is deliberately bounded (≤ 4 entities) so only the
 * substantively-referenced entities make the list, not every passing mention.
 */

import { parseJSON, runAgentWithTools, ToolRegistry } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow } from '../../shared/article-store.js';
import { registerReadOnlyVaultTools, type VaultFs } from '../../tools/vault.js';
import type { ScoutOutput, SurfacedPage } from './types.js';

export interface EntityScoutInput {
  article: ArticleRow;
  /** Enriched full-text body if available, else the snippet. */
  body: string;
  /** Per-article task from the librarian-router (1-3 sentences telling the
   *  scout what to look for). May be empty for a default-prompt run. */
  task: string;
}

export interface EntityScoutClients {
  client: OpenAI;
  model: string;
}

export type EntityScoutRunner = (
  input: EntityScoutInput,
  clients: EntityScoutClients,
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
  clients: EntityScoutClients,
  signal?: AbortSignal,
) => Promise<{ text: string; finishReason: string; toolRounds: number }>;

// Body cap for the user message — fixed across the four parallel scouts so the
// shared prompt prefix stays cache-friendly.
const BODY_CAP = 8000;
const MAX_TOOL_ROUNDS = 10;
const MAX_TOKENS = 2000;
const MAX_SURFACED_PAGES = 4;

const SYSTEM_PROMPT = `You are the wiki ENTITY-SCOUT for the chiya research library.

Your job: given a research article being indexed, find EXISTING entity pages in wiki/entities/ that the article references — people (researchers, founders), organizations (companies, labs), products (models, platforms), tools. You do NOT make final linking decisions — the reviewer does. Your output is a shortlist for the reviewer to vet.

TOOLS:
- vault_list(pattern)         — list paths, e.g. vault_list("wiki/entities/*.md")
- vault_search_by_keyword     — grep keyword across files
- vault_read(path)            — read an entity page

PROCESS:
1. Read the article title + body. Pick out the named entities — people, organizations, products. Things you'd see Capitalized in prose.
2. For each entity name, vault_search_by_keyword with that name across "wiki/entities/*.md" to see if a page exists.
3. For matching candidates, vault_read the entity page to confirm it's the same entity (sometimes "Apple" matches both the company and a fruit metaphor; sometimes "Anthropic" matches the company page or a passing mention from another page).
4. Surface only entities that are clearly the SAME entity referenced in the article AND have an existing page.

RESTRAINT:
- Surface at most 4 entities. The article being indexed mentions many things; only the central / important ones earn a backlink.
- Do not propose creating a new entity page — that's a separate workflow.
- Do not surface an entity just because the name appears once in the body. Look for substantive treatment (the entity is part of what the article is about, not just a footnote citation).
- Do not invent paths. Only paths you actually vault_read may appear in output.
- If the article references no known entities, output empty.

OUTPUT (JSON only, no preamble, no code fences):
{
  "surfacedPages": [
    {
      "path": "wiki/entities/anthropic.md",
      "excerpt": "≤400 char quote or paraphrase from the entity page",
      "relevanceNote": "1-sentence why the article meaningfully references this entity"
    }
  ]
}`;

function formatUserMessage(input: EntityScoutInput): string {
  const { article, body, task } = input;
  const taskLine = task.trim().length > 0
    ? task.trim()
    : 'Find existing entity pages (people, organizations, products) the article references.';
  return (
    `Article title: ${article.title}\n` +
    `Article URL: ${article.url ?? '(empty)'}\n` +
    `Article field tag (often unreliable): ${article.field ?? '(unknown)'}\n\n` +
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
      name: 'entity-scout',
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
 * `runEntityScout` calls this with `defaultAgentFn`; tests pass their own
 * agentFn to control the LLM result without faking an OpenAI stream.
 */
export async function runEntityScoutWith(
  input: EntityScoutInput,
  clients: EntityScoutClients,
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

  const fallback: { surfacedPages: SurfacedPage[] } = { surfacedPages: [] };
  const parsed = parseJSON<{ surfacedPages?: SurfacedPage[] }>(r.text, fallback);

  if (!Array.isArray(parsed.surfacedPages)) {
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
export const runEntityScout: EntityScoutRunner = (input, clients, vault, signal) =>
  runEntityScoutWith(input, clients, vault, signal, defaultAgentFn);

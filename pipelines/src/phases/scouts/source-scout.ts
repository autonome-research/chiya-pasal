/**
 * source-scout — one of four per-article exploration scouts in the v3
 * librarian's per-article fan-out (topic / source / entity / cite).
 *
 * Job: given a research article being indexed, surface EXISTING source pages
 * in `wiki/sources/` that the article should plausibly be cross-linked to
 * (sibling work, prior approaches, related techniques, follow-ups). The
 * reviewer downstream makes the final linking decisions; this scout only
 * produces a vetted shortlist.
 *
 * Tools: `article_search_by_title` is the primary discovery surface (returns
 * 'filename | YYYY-MM-DD | title' lines from ArticleStore). The full set of
 * `registerArticleLookupTools` is registered for cohesion — the prompt steers
 * usage toward title-search.
 *
 * Dependency-injected runner override mirrors the other scouts' pattern so
 * tests can stub the LLM call without mocking the openai module loader.
 */

import { runAgentWithTools, ToolRegistry } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow, ArticleStore } from '../../shared/article-store.js';
import type { VaultFs } from '../../tools/vault.js';
import { registerArticleLookupTools } from '../../tools/article-lookup.js';
import type { ScoutOutput } from './types.js';
import { parseSurfacedPagesJson } from './validate.js';

export interface SourceScoutInput {
  article: ArticleRow;
  /** Enriched full-text body if available, else the snippet. */
  body: string;
  /** Per-article task from the librarian-router (1-3 sentences telling the
   *  scout what to look for). May be empty for a default-prompt run. */
  task: string;
}

export interface SourceScoutClients {
  client: OpenAI;
  model: string;
}

export type SourceScoutRunner = (
  input: SourceScoutInput,
  clients: SourceScoutClients,
  vault: VaultFs,
  store: ArticleStore,
  signal?: AbortSignal,
) => Promise<ScoutOutput>;

const BODY_CAP = 8000;
const MAX_TOOL_ROUNDS = 10;
const MAX_TOKENS = 2000;
const MAX_SURFACED = 4;

const SOURCE_SCOUT_SYSTEM = `You are the wiki SOURCE-SCOUT for the chiya research library.

Your job: given a research article being indexed, find EXISTING source pages in wiki/sources/ that the article should be cross-linked to (sibling work, prior approaches, related techniques, follow-ups). You do NOT make linking decisions — the reviewer does. Your output is a shortlist of plausibly-related sources for the reviewer to vet.

TOOLS:
- article_search_by_title(keywords)  — find articles by title keywords (returns "filename | YYYY-MM-DD | title" lines)
- vault_read(path)                   — read a source page (e.g. "wiki/sources/arxiv-2605-03823.md")
- vault_list(pattern)                — list paths
- vault_exists(path)                 — check if a path exists

PROCESS:
1. Read the article title + body. Identify the 2-3 most distinctive keyword phrases (3-6 words each, technical terms preferred).
2. Use article_search_by_title on those phrases to find candidate sibling articles in the corpus. The tool returns "filename | YYYY-MM-DD | title" lines. Filename is the source page's basename (no extension); the full path is wiki/sources/{filename}.md.
3. For the most promising 2-4 candidates, vault_read("wiki/sources/{filename}.md") to verify the relationship. Look at the candidate's summary and topics.
4. Surface the pages that are CLEARLY related (same technique, follow-on work, direct comparison). Empty list is fine if nothing matches well.

RESTRAINT:
- Surface at most 4 pages. Quality over quantity.
- "Generic relevance" doesn't count — both papers being LLM papers, both being graph-related, etc., is not enough. Look for substantive overlap (same technique, same dataset, direct citation candidate).
- Do not invent paths. Only paths you actually vault_read may appear in output.
- If the article being indexed is brand new (no obvious siblings yet), output empty.

OUTPUT (JSON only, no preamble, no code fences):
{
  "surfacedPages": [
    {
      "path": "wiki/sources/arxiv-2604-25099.md",
      "excerpt": "≤400 char quote or paraphrase from the candidate page",
      "relevanceNote": "1-sentence why this is a meaningful sibling"
    }
  ]
}`;

function formatUserMessage(input: SourceScoutInput): string {
  const { article, body, task } = input;
  const taskLine = task.trim().length > 0
    ? task.trim()
    : 'Find existing source pages this article is most plausibly related to.';
  return (
    `Article title: ${article.title}\n` +
    `Article URL: ${article.url ?? '(empty)'}\n` +
    `Article field tag (often unreliable): ${article.field ?? '(unknown)'}\n\n` +
    `Article body (capped at ${BODY_CAP} chars):\n${body.slice(0, BODY_CAP)}\n\n` +
    `Librarian's task for you:\n${taskLine}`
  );
}

/** Build the read-only vault tool surface inline. Mirrors the read-side of
 *  registerVaultTools without exposing vault_write. The topic-scout may add
 *  a shared `registerReadOnlyVaultTools` helper later; until then, inline. */
function registerReadOnlyVault(registry: ToolRegistry, vault: VaultFs): void {
  registry.register(
    {
      name: 'vault_read',
      description: 'Read a file from the vault. Path is relative to the vault root.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => {
      const content = await vault.readOptional(String(path));
      return content ?? `[NOT FOUND: ${path}]`;
    },
  );

  registry.register(
    {
      name: 'vault_list',
      description: 'List vault files matching a glob pattern. Returns one path per line.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
    async ({ pattern }) => {
      const paths = await vault.list(String(pattern));
      return paths.length ? paths.join('\n') : '(no matches)';
    },
  );

  registry.register(
    {
      name: 'vault_exists',
      description: 'Check if a vault path exists. Returns "true" or "false".',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => String(await vault.exists(String(path))),
  );
}

/**
 * Default agent runner: invokes runAgentWithTools with the source-scout
 * system prompt + tool registry, parses the structured JSON output, and
 * returns a ScoutOutput. Counts `round_complete` stream events for
 * `toolRounds` telemetry. Truncation and parse failures are returned as
 * structured errors (empty surfacedPages + error string), not thrown — the
 * router fans these out in parallel and treats a failed scout as best-effort.
 */
export async function callSourceScoutAgent(
  input: SourceScoutInput,
  clients: SourceScoutClients,
  vault: VaultFs,
  store: ArticleStore,
  signal?: AbortSignal,
): Promise<ScoutOutput> {
  const registry = new ToolRegistry();
  registerReadOnlyVault(registry, vault);
  registerArticleLookupTools(registry, store);

  let toolRounds = 0;

  const r = await runAgentWithTools(
    {
      name: 'source-scout',
      systemPrompt: SOURCE_SCOUT_SYSTEM,
      model: clients.model,
      tools: registry.definitions(),
      maxToolRounds: MAX_TOOL_ROUNDS,
      maxTokens: MAX_TOKENS,
    },
    [{ role: 'user', content: formatUserMessage(input) }],
    {
      client: clients.client,
      toolExecutor: registry,
      signal,
      onStreamEvent: (ev) => {
        if (ev.type === 'round_complete') toolRounds += 1;
      },
    },
  );

  if (r.finishReason === 'length') {
    return { surfacedPages: [], error: 'truncated', toolRounds };
  }

  const parsed = parseSurfacedPagesJson(r.text, MAX_SURFACED);
  if (!parsed.ok) {
    return { surfacedPages: [], error: parsed.reason, toolRounds };
  }

  return { surfacedPages: parsed.value.surfacedPages, toolRounds };
}

/**
 * Run the source-scout for one article. Returns a ScoutOutput; never throws
 * for normal failure modes (truncation, parse failure) — those become
 * structured `error` fields. AbortError from the caller's signal still
 * propagates so the per-article fan-out can unwind on deadline.
 *
 * The default runner is dependency-injected (`agent` parameter) so tests can
 * substitute a stub without mocking the agent runner.
 */
export const runSourceScout: SourceScoutRunner = async (
  input,
  clients,
  vault,
  store,
  signal,
) => {
  return runSourceScoutWith(input, clients, vault, store, signal, callSourceScoutAgent);
};

/** Internal seam for tests: same shape as runSourceScout but with an explicit
 *  agent runner. Production callers use `runSourceScout`. */
export async function runSourceScoutWith(
  input: SourceScoutInput,
  clients: SourceScoutClients,
  vault: VaultFs,
  store: ArticleStore,
  signal: AbortSignal | undefined,
  agent: SourceScoutRunner,
): Promise<ScoutOutput> {
  return agent(input, clients, vault, store, signal);
}

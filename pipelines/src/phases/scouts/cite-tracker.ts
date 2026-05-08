/**
 * cite-tracker — one of four parallel exploration scouts in the v3 librarian's
 * per-article fan-out (topic / source / entity / cite). Given an article being
 * indexed and the arxiv IDs / DOIs already extracted upstream by refs.ts, the
 * cite-tracker resolves each ref against ArticleStore, then asks the LLM to
 * read each resolved candidate's source page and assess the citation
 * relationship (foundational / extension / comparison / background / passing).
 *
 * The scout does NOT make final cite-graph decisions — its output is a
 * relationship-annotated shortlist for the reviewer. Pre-resolution (DB lookup
 * + self-cite filter) happens in plain code; the LLM is only invoked when at
 * least one candidate survives the filter.
 */

import { parseJSON, runAgentWithTools, ToolRegistry } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow, ArticleStore } from '../../shared/article-store.js';
import type { ExtractedRefs } from '../../shared/librarian-v2-types.js';
import { registerArticleLookupTools } from '../../tools/article-lookup.js';
import { registerReadOnlyVaultTools, type VaultFs } from '../../tools/vault.js';
import { stableIdForUrl, stableIdToFilename } from '../page-templates.js';
import type { ScoutOutput, SurfacedPage } from './types.js';

export interface CiteTrackerInput {
  article: ArticleRow;
  /** Enriched full-text body if available, else the snippet. */
  body: string;
  /** Refs already extracted upstream by batchExtractRefs. */
  refs: ExtractedRefs;
  /** Per-article task from the librarian-router. */
  task: string;
}

export interface CiteTrackerClients {
  client: OpenAI;
  model: string;
}

export type CiteTrackerRunner = (
  input: CiteTrackerInput,
  clients: CiteTrackerClients,
  vault: VaultFs,
  store: ArticleStore,
  signal?: AbortSignal,
) => Promise<ScoutOutput>;

/**
 * Dependency-injected agent invocation. Lets tests bypass runAgentWithTools and
 * supply canned outputs (text, finishReason, toolRounds) without faking an
 * OpenAI stream. Defaults to the real runAgentWithTools-backed implementation.
 */
export type CiteAgentFn = (
  systemPrompt: string,
  userMessage: string,
  registry: ToolRegistry,
  clients: CiteTrackerClients,
  signal?: AbortSignal,
) => Promise<{ text: string; finishReason: string; toolRounds: number }>;

/** A reference resolved against ArticleStore — surfaced to the LLM as a
 *  candidate for relationship assessment. */
export interface ResolvedCandidate {
  filename: string;
  title: string;
  url: string;
  refType: 'arxiv' | 'doi';
  refValue: string;
}

// Body cap for the user message — cite-tracker doesn't need the full body to
// assess relationships; the candidate source pages carry the substance.
const BODY_CAP = 4000;
const MAX_TOOL_ROUNDS = 12;
const MAX_TOKENS = 2000;
const MAX_SURFACED_PAGES = 6;

const SYSTEM_PROMPT = `You are the wiki CITE-TRACKER for the chiya research library.

Your job: given a research article being indexed and a list of CANDIDATE references that have already been resolved against the library, vault_read each candidate's source page to assess the citation relationship. You do NOT make final cite-graph decisions — the reviewer does. Your output is a shortlist of relationship-annotated cites.

TOOLS:
- vault_read(path)                — read a source page
- vault_exists(path)              — check existence
- article_lookup_by_arxiv         — usually unnecessary (candidates already resolved)
- article_lookup_by_doi           — usually unnecessary (candidates already resolved)

PROCESS:
1. The user message lists candidate cites — each with filename, title, and the ref type (arxiv or doi).
2. For each candidate, vault_read("wiki/sources/{filename}.md") to see the candidate's summary.
3. Compare the candidate's summary to the article being indexed. What kind of cite is this?
   - "foundational" — the article builds directly on this work
   - "comparison" — the article tests against / contrasts with this
   - "extension" — the article extends / modifies this approach
   - "background" — the article cites this as prior art for context
   - "passing" — mentioned but not central; SKIP these (don't surface)
4. Surface only the cites that are genuinely meaningful (foundational / comparison / extension / strong background).

RESTRAINT:
- Surface at most 6 cites.
- Skip "passing" mentions — they don't deserve a backlink.
- Do not invent paths. Only the candidate paths from the user message may appear in output.
- If all candidates are passing mentions, output empty.

OUTPUT (JSON only, no preamble, no code fences):
{
  "surfacedPages": [
    {
      "path": "wiki/sources/arxiv-2403-12345.md",
      "excerpt": "≤400 char quote or paraphrase from the cited source's summary",
      "relevanceNote": "1-sentence on the relationship type and substance"
    }
  ]
}`;

/**
 * Pre-resolve refs against ArticleStore. Each surviving candidate has been
 * looked up and is NOT a self-cite (the article's own URL). The LLM never sees
 * raw refs — only resolved candidates with filenames it can vault_read.
 */
export function preResolveCandidates(
  refs: ExtractedRefs,
  article: ArticleRow,
  store: ArticleStore,
): ResolvedCandidate[] {
  const out: ResolvedCandidate[] = [];
  // Self-cite guard: an article's own arxiv ID often appears in its enriched
  // body (header, watermark, etc.); we don't want to surface a self-cite.
  const selfUrl = article.url ?? '';
  const seen = new Set<string>(); // dedup by filename in case arxiv and DOI both resolve to same row

  for (const arxivId of refs.arxivIds) {
    const row = store.findByArxivId(arxivId);
    if (!row || !row.url) continue;
    if (row.url === selfUrl) continue;
    const sid = stableIdForUrl(row.url);
    if (!sid) continue;
    const filename = stableIdToFilename(sid);
    if (seen.has(filename)) continue;
    seen.add(filename);
    out.push({
      filename,
      title: row.title,
      url: row.url,
      refType: 'arxiv',
      refValue: arxivId,
    });
  }

  for (const doi of refs.dois) {
    const row = store.findByDoi(doi);
    if (!row || !row.url) continue;
    if (row.url === selfUrl) continue;
    const sid = stableIdForUrl(row.url);
    if (!sid) continue;
    const filename = stableIdToFilename(sid);
    if (seen.has(filename)) continue;
    seen.add(filename);
    out.push({
      filename,
      title: row.title,
      url: row.url,
      refType: 'doi',
      refValue: doi,
    });
  }

  return out;
}

function formatUserMessage(input: CiteTrackerInput, candidates: ResolvedCandidate[]): string {
  const { article, body, task } = input;
  const taskLine = task.trim().length > 0
    ? task.trim()
    : 'Assess each candidate cite\'s relationship to the article being indexed. Skip passing mentions.';

  const candidateLines = candidates.map((c, i) => {
    const refLabel = c.refType === 'arxiv' ? `arxiv:${c.refValue}` : `doi:${c.refValue}`;
    return `[${i + 1}] ${c.filename} | ${c.url} | "${c.title}" (ref: ${refLabel})`;
  });

  return (
    `Article title: ${article.title}\n` +
    `Article URL: ${article.url ?? '(empty)'}\n\n` +
    `Article body excerpt (capped at ${BODY_CAP} chars — cite-tracker doesn't need full body):\n` +
    `${body.slice(0, BODY_CAP)}\n\n` +
    `Resolved citation candidates (already looked up against the library):\n` +
    `${candidateLines.join('\n')}\n\n` +
    `Librarian's task for you:\n${taskLine}`
  );
}

/** Real agent invocation — runs the runAgentWithTools loop with the scout's
 *  read-only vault tools + article-lookup tools. */
const defaultAgentFn: CiteAgentFn = async (
  systemPrompt,
  userMessage,
  registry,
  clients,
  signal,
) => {
  const r = await runAgentWithTools(
    {
      name: 'cite-tracker',
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
 * `runCiteTracker` calls this with `defaultAgentFn`; tests pass their own
 * agentFn to control the LLM result without faking an OpenAI stream.
 */
export async function runCiteTrackerWith(
  input: CiteTrackerInput,
  clients: CiteTrackerClients,
  vault: VaultFs,
  store: ArticleStore,
  signal: AbortSignal | undefined,
  agentFn: CiteAgentFn,
): Promise<ScoutOutput> {
  // Pre-resolve refs against ArticleStore. If nothing resolves, there's
  // nothing for the LLM to assess — short-circuit without an LLM call.
  const candidates = preResolveCandidates(input.refs, input.article, store);
  if (candidates.length === 0) {
    return { surfacedPages: [] };
  }

  const registry = new ToolRegistry();
  registerReadOnlyVaultTools(registry, vault);
  registerArticleLookupTools(registry, store);

  const userMessage = formatUserMessage(input, candidates);

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
  let parseError: string | undefined;
  const parsed = parseJSON<{ surfacedPages?: SurfacedPage[] }>(
    r.text,
    fallback,
    (_preview, err) => {
      parseError = `parse-failed: ${err.message.slice(0, 120)}`;
    },
  );

  if (parseError) {
    return { surfacedPages: [], error: parseError, toolRounds: r.toolRounds };
  }
  if (!Array.isArray(parsed.surfacedPages)) {
    return { surfacedPages: [], error: 'parse-failed', toolRounds: r.toolRounds };
  }

  // Sanitize: drop entries missing required fields, cap to MAX_SURFACED_PAGES.
  const cleaned: SurfacedPage[] = [];
  for (const p of parsed.surfacedPages) {
    if (
      !p ||
      typeof p.path !== 'string' ||
      typeof p.excerpt !== 'string' ||
      typeof p.relevanceNote !== 'string'
    ) {
      continue;
    }
    cleaned.push({ path: p.path, excerpt: p.excerpt, relevanceNote: p.relevanceNote });
    if (cleaned.length >= MAX_SURFACED_PAGES) break;
  }

  return { surfacedPages: cleaned, toolRounds: r.toolRounds };
}

/** Real implementation — runAgentWithTools loop with read-only vault tools +
 *  article-lookup tools. Pre-resolves refs in code first. */
export const runCiteTracker: CiteTrackerRunner = (input, clients, vault, store, signal) =>
  runCiteTrackerWith(input, clients, vault, store, signal, defaultAgentFn);

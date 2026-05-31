/**
 * reviewer — sequential synthesis agent in the v3 librarian's per-article flow.
 *
 * Receives the article + the four scouts' surfacedPages and decides the final
 * recommended topics, cites, related sources, and entities. Has vault_read
 * access for verifying any path the scouts surfaced — the reviewer can
 * disagree with a scout and re-read the page to make its own call.
 *
 * Output is reconciled against existing topic slugs (folding false-news,
 * dropping hallucinations) and gated for new-topic creation (near-duplicate
 * + definition-substantiveness checks). The librarian then writes
 * deterministically.
 */

import { runAgentWithTools, ToolRegistry } from 'thread-phase';
import type OpenAI from 'openai';

import type { ArticleRow } from '../shared/article-store.js';
import {
  invalid,
  isRecord,
  parseAndValidateJson,
  valid,
  type Validator,
} from '../shared/llm-schema.js';
import type { VaultFs } from '../tools/vault.js';
import { registerReadOnlyVaultTools } from '../tools/vault.js';
import type { ScoutOutput, SurfacedPage } from './scouts/types.js';
import {
  isNearDuplicate,
  isSubstantiveDefinition,
  reconcileTopicOutput,
  type TopicOutput,
} from './topic-reconciler.js';

export interface ReviewerInput {
  article: ArticleRow;
  body: string;
  topicScout: ScoutOutput;
  sourceScout: ScoutOutput;
  entityScout: ScoutOutput;
  citeTracker: ScoutOutput;
}

export interface ReviewerClients {
  client: OpenAI;
  model: string;
}

/** Reviewer's recommendation for a topic membership. */
export interface ReviewerTopic {
  slug: string;
  why: string;
  /** Set when the reviewer is proposing a new topic (not currently in the
   *  vault). Definition is required for new topics so the librarian's gate
   *  can apply isSubstantiveDefinition. */
  isNew?: boolean;
  definition?: string;
}

export interface ReviewerCite {
  /** Vault filename WITHOUT the wiki/sources/ prefix and WITHOUT .md. */
  filename: string;
  why: string;
}

export interface ReviewerRelated {
  filename: string;
  why: string;
}

export interface ReviewerEntity {
  /** Vault filename WITHOUT the wiki/entities/ prefix and WITHOUT .md. */
  slug: string;
  why: string;
}

export interface ReviewerOutput {
  topics: ReviewerTopic[];
  cites: ReviewerCite[];
  related: ReviewerRelated[];
  entities: ReviewerEntity[];
  /** Set when the LLM call truncated, threw, or parse failed. The librarian
   *  treats a present error as "no recommendations; mark uncategorized". */
  error?: string;
  toolRounds?: number;
}

/** What the librarian does with the reviewer's output AFTER reconcile + gate. */
export interface GatedRecommendations {
  /** Existing-topic slugs the article gets filed under. */
  existingTopicSlugs: string[];
  /** New-topic proposals that PASSED the gate. Each will get a fresh topic
   *  page created by the librarian. */
  newTopicsToCreate: Array<{ slug: string; definition: string }>;
  /** Cite filenames whose source pages exist in the vault. */
  citeFilenames: string[];
  /** Entity slugs whose pages exist in the vault. */
  entitySlugs: string[];
  /** Related-source filenames whose pages exist (for "## Related sources"
   *  sections — currently informational only, not landed in the source-page
   *  template; the librarian can fold these into cites as it sees fit). */
  relatedFilenames: string[];
  /** Diagnostic: counts of what got dropped at each gate. */
  gateStats: {
    foldedSlugs: number;
    droppedHallucinations: number;
    rejectedNearDuplicates: number;
    rejectedThinDefinition: number;
  };
}

const REVIEWER_SYSTEM = `You are the wiki REVIEWER for the chiya research library.

Four scouts have explored the wiki in parallel and surfaced candidate pages relevant to the article being indexed. Your job: read the article + scouts' findings, then recommend the FINAL topics, cites, related sources, and entities for this article.

You have one tool: vault_read(path). Use it sparingly — only to verify scout findings you're uncertain about, not to re-explore from scratch. The scouts have already done the exploration.

WHAT EACH SCOUT SURFACED:
- topicScout    — wiki/topics/...    pages relevant by subject
- sourceScout   — wiki/sources/...   sibling source pages
- entityScout   — wiki/entities/...  named-entity pages
- citeTracker   — wiki/sources/...   actual citations resolved against the library

POLICIES:

1. RESTRAINT. Don't tag everything that's plausible. Tag only what's CLEARLY relevant. Better to under-tag than over-tag.
   - topics: aim for 1-3 (rarely 4)
   - cites:  only the cite-tracker's findings; trust their assessment
   - related: 0-3 source pages from sourceScout — only if a real connection
   - entities: 0-3 entity pages — only if substantively about the entity, not just mentioned

2. PREFER EXISTING. Only propose a NEW topic if no existing topic page is a fit. New topics need:
   - A lowercase-hyphen slug (no spaces)
   - A 1-2 sentence definition that would be true 5 years from now (a research area, not a paper title)
   - Genuine novelty (the topicScout didn't surface anything close)

3. CITE-TRACKER IS AUTHORITATIVE on cites. If the cite-tracker surfaced 4 pages, your cites list is some subset of those 4. Don't add cites the cite-tracker didn't find.

4. EVERY ARTICLE MUST HAVE AT LEAST ONE topic slug. If nothing fits and no new topic is justified, use "uncategorized" as the slug.

OUTPUT (JSON only, no preamble, no code fences):
{
  "topics":   [{ "slug": "existing-or-new-slug", "why": "1 sentence", "isNew": true_if_new, "definition": "1-2 sentences (only if isNew)" }],
  "cites":    [{ "filename": "arxiv-2403-12345", "why": "1 sentence" }],
  "related":  [{ "filename": "arxiv-2604-25099", "why": "1 sentence" }],
  "entities": [{ "slug": "anthropic", "why": "1 sentence" }]
}

The "why" fields are for the audit trail and the librarian's logs; keep them short.`;

const BODY_CAP = 4000;

function summarizeScout(name: string, output: ScoutOutput): string {
  if (output.error) return `${name}: error="${output.error}"`;
  if (output.surfacedPages.length === 0) return `${name}: (no pages surfaced)`;
  const lines = output.surfacedPages.map((p: SurfacedPage, i: number) =>
    `  [${i + 1}] ${p.path}\n      excerpt: ${p.excerpt.slice(0, 240)}\n      why: ${p.relevanceNote}`,
  );
  return `${name} surfaced ${output.surfacedPages.length}:\n${lines.join('\n')}`;
}

function buildUserMessage(input: ReviewerInput): string {
  return (
    `Article title: ${input.article.title}\n` +
    `URL: ${input.article.url ?? '(empty)'}\n` +
    `Field tag: ${input.article.field ?? '(unknown)'}\n\n` +
    `Body excerpt (capped at ${BODY_CAP} chars):\n${input.body.slice(0, BODY_CAP)}\n\n` +
    `Scout findings:\n\n` +
    summarizeScout('topicScout', input.topicScout) + '\n\n' +
    summarizeScout('sourceScout', input.sourceScout) + '\n\n' +
    summarizeScout('entityScout', input.entityScout) + '\n\n' +
    summarizeScout('citeTracker', input.citeTracker)
  );
}

/** DI seam — same pattern as the scouts and the router. */
export type ReviewerAgentFn = (
  systemPrompt: string,
  userMessage: string,
  registry: ToolRegistry,
  clients: ReviewerClients,
  signal?: AbortSignal,
) => Promise<{ text: string; finishReason: string; toolRounds: number }>;

const defaultAgentFn: ReviewerAgentFn = async (systemPrompt, userMessage, registry, clients, signal) => {
  const r = await runAgentWithTools(
    {
      name: 'reviewer',
      systemPrompt,
      model: clients.model,
      tools: registry.definitions(),
      maxToolRounds: 6,
      maxTokens: 2500,
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

/** Runner with DI override for tests. */
export async function runReviewerWith(
  input: ReviewerInput,
  clients: ReviewerClients,
  vault: VaultFs,
  signal: AbortSignal | undefined,
  agentFn: ReviewerAgentFn,
): Promise<ReviewerOutput> {
  const registry = new ToolRegistry();
  registerReadOnlyVaultTools(registry, vault);

  const userMessage = buildUserMessage(input);
  let r: { text: string; finishReason: string; toolRounds: number };
  try {
    r = await agentFn(REVIEWER_SYSTEM, userMessage, registry, clients, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      topics: [],
      cites: [],
      related: [],
      entities: [],
      error: msg.slice(0, 200),
    };
  }
  if (r.finishReason === 'length') {
    return {
      topics: [],
      cites: [],
      related: [],
      entities: [],
      error: 'truncated',
      toolRounds: r.toolRounds,
    };
  }

  const fallback: ReviewerOutput = {
    topics: [],
    cites: [],
    related: [],
    entities: [],
    toolRounds: r.toolRounds,
  };
  const parsed = parseAndValidateJson(r.text, validateReviewerOutput);
  if (!parsed.ok) {
    return { ...fallback, error: parsed.reason };
  }
  return { ...parsed.value, toolRounds: r.toolRounds };
}

export type ReviewerRunner = (
  input: ReviewerInput,
  clients: ReviewerClients,
  vault: VaultFs,
  signal?: AbortSignal,
) => Promise<ReviewerOutput>;

export const runReviewer: ReviewerRunner = (input, clients, vault, signal) =>
  runReviewerWith(input, clients, vault, signal, defaultAgentFn);

// ---------------------------------------------------------------------------
// Sanitization — drop malformed entries the LLM might emit.
// ---------------------------------------------------------------------------

const MAX_TOPICS = 4;
const MAX_CITES = 6;
const MAX_RELATED = 3;
const MAX_ENTITIES = 3;

const validateReviewerOutput: Validator<Omit<ReviewerOutput, 'toolRounds' | 'error'>> = (value) => {
  if (!isRecord(value)) return invalid('invalid-shape');
  return valid({
    topics: sanitizeTopics(value.topics),
    cites: sanitizeCites(value.cites),
    related: sanitizeRelated(value.related),
    entities: sanitizeEntities(value.entities),
  });
};

function isStr(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function sanitizeTopics(raw: unknown): ReviewerTopic[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewerTopic[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (!isStr(o.slug) || !isStr(o.why)) continue;
    const isNew = o.isNew === true;
    const definition = isStr(o.definition) ? o.definition : undefined;
    if (isNew && !definition) continue; // new topic without a definition can't be gated
    out.push({ slug: o.slug.trim(), why: o.why.trim(), isNew: isNew || undefined, definition });
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

function sanitizeCites(raw: unknown): ReviewerCite[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewerCite[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (!isStr(o.filename) || !isStr(o.why)) continue;
    out.push({ filename: o.filename.trim(), why: o.why.trim() });
    if (out.length >= MAX_CITES) break;
  }
  return out;
}

function sanitizeRelated(raw: unknown): ReviewerRelated[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewerRelated[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (!isStr(o.filename) || !isStr(o.why)) continue;
    out.push({ filename: o.filename.trim(), why: o.why.trim() });
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}

function sanitizeEntities(raw: unknown): ReviewerEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewerEntity[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (!isStr(o.slug) || !isStr(o.why)) continue;
    out.push({ slug: o.slug.trim(), why: o.why.trim() });
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconcile + gate — the librarian calls this AFTER getting the reviewer's
// output. Pure function: takes the reviewer output + ground-truth state of
// the vault, returns what should actually be written.
// ---------------------------------------------------------------------------

export interface GateInputs {
  reviewer: ReviewerOutput;
  /** All existing topic slugs (basenames of wiki/topics/*.md, no extension). */
  existingTopicSlugs: ReadonlySet<string>;
  /** Predicate: does wiki/sources/{filename}.md exist? Used to filter cites
   *  and related references. */
  sourceExists: (filename: string) => boolean | Promise<boolean>;
  /** Predicate: does wiki/entities/{slug}.md exist? */
  entityExists: (slug: string) => boolean | Promise<boolean>;
}

export async function applyReconcileAndGate(input: GateInputs): Promise<GatedRecommendations> {
  // 1. Topic reconcile (fold false-new + drop hallucinations) using the
  //    existing reconciler shape. Build a TopicOutput from reviewer.topics.
  const topicOut: TopicOutput = {
    decisions: [
      { i: 0, topics: input.reviewer.topics.map((t) => t.slug) },
    ],
    newTopics: input.reviewer.topics
      .filter((t) => t.isNew && t.definition)
      .map((t) => ({ slug: t.slug, definition: t.definition!, members: [0] })),
  };
  const reconciled = reconcileTopicOutput(topicOut, input.existingTopicSlugs);

  // 2. New-topic gate: drop near-duplicates + thin definitions.
  const newTopicsToCreate: Array<{ slug: string; definition: string }> = [];
  let rejectedNearDuplicates = 0;
  let rejectedThinDefinition = 0;
  for (const proposal of reconciled.reconciled.newTopics) {
    const dup = isNearDuplicate(proposal.slug, input.existingTopicSlugs);
    if (dup.duplicate) {
      rejectedNearDuplicates++;
      continue;
    }
    if (!isSubstantiveDefinition(proposal.definition)) {
      rejectedThinDefinition++;
      continue;
    }
    newTopicsToCreate.push({ slug: proposal.slug, definition: proposal.definition });
  }
  const passedNewSlugs = new Set(newTopicsToCreate.map((t) => t.slug));

  // 3. Final topic slugs for the article = reconciled decision slugs MINUS
  //    rejected new-topic proposals. (Reconciler kept their slug in
  //    decisions; the gate removes them retroactively.)
  const decisionSlugs = reconciled.reconciled.decisions[0]?.topics ?? [];
  const allowedNewSlugs = new Set(reconciled.reconciled.newTopics.map((nt) => nt.slug));
  const finalSlugs = decisionSlugs.filter((slug) => {
    if (input.existingTopicSlugs.has(slug)) return true;
    if (allowedNewSlugs.has(slug) && passedNewSlugs.has(slug)) return true;
    if (slug === 'uncategorized') return true;
    return false; // proposed-new but rejected by gate → drop
  });
  const existingTopicSlugs = finalSlugs.length > 0
    ? finalSlugs
    : ['uncategorized'];

  // 4. Cite + entity + related existence checks against the vault.
  const citeFilenames: string[] = [];
  for (const c of input.reviewer.cites) {
    if (await input.sourceExists(c.filename)) citeFilenames.push(c.filename);
  }
  const entitySlugs: string[] = [];
  for (const e of input.reviewer.entities) {
    if (await input.entityExists(e.slug)) entitySlugs.push(e.slug);
  }
  const relatedFilenames: string[] = [];
  for (const r of input.reviewer.related) {
    if (await input.sourceExists(r.filename)) relatedFilenames.push(r.filename);
  }

  return {
    existingTopicSlugs,
    newTopicsToCreate,
    citeFilenames,
    entitySlugs,
    relatedFilenames,
    gateStats: {
      foldedSlugs: reconciled.foldedSlugs.length,
      droppedHallucinations: reconciled.droppedHallucinations.length,
      rejectedNearDuplicates,
      rejectedThinDefinition,
    },
  };
}

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
import {
  isKnownSlug,
  nearestSlugs,
  type TopicRecord,
  type TopicRegistry,
} from '../shared/topic-registry.js';
import type { VaultFs } from '../tools/vault.js';
import { registerReadOnlyVaultTools } from '../tools/vault.js';
import { asEntityKind, sanitizeSlug, type EntityKind } from './entity-templates.js';
import { UNCATEGORIZED_TOPIC } from './page-templates.js';
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
  /** Cluster-grouped slug inventory rendered ONCE per librarian run
   *  (vocabularyForPrompt). Absent means "no registry available" — the
   *  reviewer then works blind, as it did before the registry existed. */
  vocabulary?: string;
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
  /** Soft cluster memberships for a NEW topic, chosen from the registry's
   *  cluster names. Validated for shape only, never for membership: the
   *  cluster vocabulary has to be able to grow, and 55% of live topics carry
   *  no cluster at all. Ignored for existing topics (the page owns its own). */
  clusters?: string[];
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
  /** Display name for a page that does not exist yet. */
  name?: string;
  /** person | organization | product | tool | other; anything else → omitted. */
  kind?: EntityKind;
}

export interface ReviewerOutput {
  topics: ReviewerTopic[];
  cites: ReviewerCite[];
  related: ReviewerRelated[];
  entities: ReviewerEntity[];
  /** Set when the LLM call truncated, threw, or parse failed. The planner
   *  defers the article for retry (see REVIEWER_FAILURE_MAX_DEFERRALS);
   *  once deferrals are exhausted, apply files it uncategorized as a
   *  logged last resort. */
  error?: string;
  toolRounds?: number;
}

/**
 * Reviewer-failure deferral bookkeeping. When the reviewer errors, the planner
 * defers the article (apply returns it to pending) instead of filing it as
 * uncategorized and silently dropping its cites/related/entities. The attempt
 * marker rides in the row's status_reason; after MAX deferrals the next
 * attempt falls through to degraded uncategorized filing so a persistent
 * outage cannot wedge the queue.
 */
export const REVIEWER_FAILURE_MAX_DEFERRALS = 2;

const REVIEWER_FAILURE_PREFIX = 'reviewer-failed';
const REVIEWER_FAILURE_ATTEMPT_RE = /^reviewer-failed \(attempt (\d+)\)/;

export function isReviewerFailureReason(reason: string | null | undefined): boolean {
  return reason != null && reason.startsWith(REVIEWER_FAILURE_PREFIX);
}

/** Deferral attempts already recorded on the row's status_reason (0 when none). */
export function reviewerFailureAttempts(statusReason: string | null): number {
  const m = statusReason ? REVIEWER_FAILURE_ATTEMPT_RE.exec(statusReason) : null;
  return m ? Number(m[1]) : 0;
}

/** status_reason / deferral reason carrying the attempt marker. Capped at the
 *  store's 200-char status_reason convention. */
export function reviewerFailureReason(attempt: number, error: string): string {
  return `reviewer-failed (attempt ${attempt}): ${error}`.slice(0, 200);
}

/** What the librarian does with the reviewer's output AFTER reconcile + gate. */
export interface GatedRecommendations {
  /** Existing-topic slugs the article gets filed under. */
  existingTopicSlugs: string[];
  /** New-topic proposals that PASSED the gate. Each will get a fresh topic
   *  page created by the librarian, carrying the reviewer's clusters. */
  newTopicsToCreate: Array<{ slug: string; definition: string; clusters: string[] }>;
  /** Cite filenames whose source pages exist in the vault. */
  citeFilenames: string[];
  /** Entities to upsert. NOT filtered by existence: a missing page is created
   *  with this article as its first backlink (apply decides create vs append
   *  against fresh vault state). */
  entities: Array<{ slug: string; name: string | null; kind: EntityKind | null }>;
  /** Related-source filenames whose pages exist; rendered on the new source page
   *  as frontmatter graph edges plus a "## Related sources" section. */
  relatedFilenames: string[];
  /** Diagnostic: counts of what got dropped (or repaired) at each gate. */
  gateStats: {
    foldedSlugs: number;
    droppedHallucinations: number;
    rejectedNearDuplicates: number;
    rejectedThinDefinition: number;
    /** Unknown slugs snapped onto an existing one before reconcile. */
    fuzzyCorrected: number;
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
   - "clusters": 1-2 cluster names taken from the vocabulary block below (or [] if none fit). Clusters are soft, overlapping labels — never a hierarchy.

3. CITE-TRACKER IS AUTHORITATIVE on cites. If the cite-tracker surfaced 4 pages, your cites list is some subset of those 4. Don't add cites the cite-tracker didn't find.

4. EVERY ARTICLE MUST HAVE AT LEAST ONE topic slug. If nothing fits and no new topic is justified, use "uncategorized" as the slug.

5. ENTITIES ARE PAGES. An entity you recommend gets a wiki/entities page — created if it doesn't exist yet, with this article as its first backlink. So use a canonical lowercase-hyphen slug ("anthropic", not "Anthropic Inc."), and only name entities the article is substantively about.

OUTPUT (JSON only, no preamble, no code fences):
{
  "topics":   [{ "slug": "existing-or-new-slug", "why": "1 sentence", "isNew": true_if_new, "definition": "1-2 sentences (only if isNew)", "clusters": ["cluster-name"] }],
  "cites":    [{ "filename": "arxiv-2403-12345", "why": "1 sentence" }],
  "related":  [{ "filename": "arxiv-2604-25099", "why": "1 sentence" }],
  "entities": [{ "slug": "anthropic", "name": "Anthropic", "kind": "organization", "why": "1 sentence" }]
}

"kind" is one of person, organization, product, tool, other. The "why" fields are for the audit trail and the librarian's logs; keep them short.`;

/** Heading the run-level topic vocabulary is injected under. Exported so the
 *  planner/tests can assert the reviewer actually sees the vocabulary — the
 *  blindness this fixes is what produced 57% `uncategorized` sources. */
export const REVIEWER_VOCABULARY_HEADING =
  '## Existing topic vocabulary (assign to these when applicable; propose new only when nothing fits)';

/**
 * System prompt for one librarian run. The vocabulary block is appended (not
 * interleaved) so the static policy prefix stays byte-identical across runs
 * for prompt caching, and it is rendered once per run rather than per article.
 */
export function buildReviewerSystemPrompt(vocabulary?: string): string {
  const vocab = vocabulary?.trim();
  if (!vocab) return REVIEWER_SYSTEM;
  return (
    `${REVIEWER_SYSTEM}\n\n${REVIEWER_VOCABULARY_HEADING}\n\n` +
    'Each line is "cluster (topic count): slugs". Every slug listed EXISTS — use it verbatim. ' +
    '"(+N more)" means that cluster\'s list was elided to fit, so absence from this block is weak ' +
    'evidence; the topicScout\'s findings are authoritative for pages it actually read. ' +
    'Cluster names on the left are the vocabulary for the "clusters" field of a new topic.\n\n' +
    vocab
  );
}

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

/**
 * Output-token budget for the reviewer.
 *
 * 2500 was sized for a non-reasoning model and before the topic vocabulary
 * (up to 6k chars of slugs) entered the prompt: qwen3 reasons over which of
 * ~2.6k topics fit, and the hidden reasoning pass consumed the whole cap
 * before any JSON appeared — 31 articles deferred on `truncated` in one
 * evening, which is the very uncategorized-filing failure the vocabulary was
 * added to prevent. Matches the digest's fast-tier cap; override for
 * thriftier non-reasoning models.
 */
const REVIEWER_MAX_TOKENS = Math.max(
  1000,
  Number(process.env.CHIYA_REVIEWER_MAX_TOKENS ?? '5000') || 5000,
);

const defaultAgentFn: ReviewerAgentFn = async (systemPrompt, userMessage, registry, clients, signal) => {
  const r = await runAgentWithTools(
    {
      name: 'reviewer',
      systemPrompt,
      model: clients.model,
      tools: registry.definitions(),
      maxToolRounds: 6,
      maxTokens: REVIEWER_MAX_TOKENS,
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
  const systemPrompt = buildReviewerSystemPrompt(input.vocabulary);
  let r: { text: string; finishReason: string; toolRounds: number };
  try {
    r = await agentFn(systemPrompt, userMessage, registry, clients, signal);
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

const MAX_CLUSTERS_PER_TOPIC = 2;

/** Cluster names are shape-validated only (never checked against the registry):
 *  the cluster vocabulary must be able to grow, since history recovery cannot
 *  cluster the 1.4k topics that were born flat. */
function sanitizeClusters(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string') continue;
    const slug = sanitizeSlug(c);
    if (!slug || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= MAX_CLUSTERS_PER_TOPIC) break;
  }
  return out;
}

function sanitizeTopics(raw: unknown): ReviewerTopic[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewerTopic[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (!isStr(o.slug) || !isStr(o.why)) continue;
    // Slugs become file paths; sanitize at the LLM boundary so nothing
    // downstream has to defend against spaces or traversal.
    const slug = sanitizeSlug(o.slug);
    if (!slug) continue;
    const isNew = o.isNew === true;
    const definition = isStr(o.definition) ? o.definition : undefined;
    if (isNew && !definition) continue; // new topic without a definition can't be gated
    out.push({
      slug,
      why: o.why.trim(),
      isNew: isNew || undefined,
      definition,
      clusters: isNew ? sanitizeClusters(o.clusters) : undefined,
    });
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
    const slug = sanitizeSlug(o.slug);
    if (!slug) continue;
    const kind = asEntityKind(o.kind);
    out.push({
      slug,
      why: o.why.trim(),
      name: isStr(o.name) ? o.name.trim().slice(0, 120) : undefined,
      kind: kind ?? undefined,
    });
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
}

/**
 * Number of fuzzy candidates considered per unknown slug. `nearestSlugs`
 * proposes (recall); `isNearDuplicate` disposes (precision) — the same
 * detector the new-topic gate uses, so a slug can never be corrected onto
 * something the gate would have called distinct.
 */
const FUZZY_CANDIDATES = 3;

/** Minimal TopicRecord so the registry lookups can run against the slug set
 *  apply just read from disk. The run-level registry tells the AGENTS what
 *  exists; the gate must be right about what exists NOW, and a scan-fresh
 *  slug set is the only source of that truth. */
function registryOfSlugs(slugs: ReadonlySet<string>): TopicRegistry {
  const topics: TopicRecord[] = [...slugs].sort().map((slug) => ({
    slug,
    title: slug,
    oneLiner: null,
    clusters: [],
    memberCount: 0,
    citedByTotal: 0,
    updated: null,
  }));
  return { topics, clusters: {}, generatedAt: '' };
}

/** Edit budget for accepting a correction, scaled by slug length. Slugs
 *  shorter than this never correct on distance alone: at 5 characters one
 *  edit is the difference between `gpt-4` and `gpt-5`. */
const MIN_FUZZY_SLUG_LEN = 8;
const MAX_FUZZY_EDITS = 3;

/** Local copy: topic-registry owns the scoring used to RANK candidates, this
 *  module owns the threshold used to ACCEPT one, and the two are tuned
 *  independently (ranking is generous by design). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

function withinEditBudget(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < MIN_FUZZY_SLUG_LEN) return false;
  return levenshtein(a, b) <= Math.min(MAX_FUZZY_EDITS, Math.ceil(maxLen / 6));
}

/**
 * `nearestSlugs` proposes; this disposes. A candidate is only accepted when it
 * is either a near-duplicate by the new-topic gate's own rule (so correction
 * can never contradict the gate) or within a length-scaled edit budget, which
 * is what catches the typo/plural drift the gate's prefix rule misses
 * ('quantum-sesning' → 'quantum-sensing').
 */
function correctToKnownSlug(reg: TopicRegistry, slug: string): string | null {
  // The length floor guards BOTH acceptance branches: isNearDuplicate's
  // prefix rule has no floor of its own, and at short lengths it folds
  // distinct model names ('gpt-4' → 'gpt-4o') — exactly the confusion
  // MIN_FUZZY_SLUG_LEN exists to prevent.
  if (slug.length < MIN_FUZZY_SLUG_LEN) return null;
  for (const candidate of nearestSlugs(reg, slug, FUZZY_CANDIDATES)) {
    if (!isKnownSlug(reg, candidate)) continue;
    if (isNearDuplicate(slug, new Set([candidate])).duplicate) return candidate;
    if (withinEditBudget(slug.toLowerCase(), candidate.toLowerCase())) return candidate;
  }
  return null;
}

export async function applyReconcileAndGate(input: GateInputs): Promise<GatedRecommendations> {
  // 0. Fuzzy correction. A slug the vault doesn't know but that is one typo /
  //    plural / word-order away from one it does used to be dropped as a
  //    hallucination (or rejected as a near-duplicate new topic) and the
  //    article fell through to 'uncategorized'. Snap it instead. Genuinely
  //    novel slugs are left untouched for the new-topic path below.
  let fuzzyCorrected = 0;
  // Built lazily: most articles propose only slugs that already match, and
  // materializing the vault's whole slug namespace per article is wasted work
  // when nothing needs correcting.
  let slugRegistry: TopicRegistry | null = null;
  const topics: ReviewerTopic[] = input.reviewer.topics.map((t) => {
    if (t.slug === UNCATEGORIZED_TOPIC || input.existingTopicSlugs.has(t.slug)) return t;
    slugRegistry ??= registryOfSlugs(input.existingTopicSlugs);
    const corrected = correctToKnownSlug(slugRegistry, t.slug);
    if (!corrected) return t;
    fuzzyCorrected++;
    // Now an existing page: it owns its own definition and clusters.
    return { slug: corrected, why: t.why };
  });

  // 1. Topic reconcile (fold false-new + drop hallucinations) using the
  //    existing reconciler shape. Build a TopicOutput from reviewer.topics.
  const topicOut: TopicOutput = {
    decisions: [
      { i: 0, topics: topics.map((t) => t.slug) },
    ],
    newTopics: topics
      .filter((t) => t.isNew && t.definition)
      .map((t) => ({
        slug: t.slug,
        definition: t.definition!,
        members: [0],
        clusters: t.clusters ?? [],
      })),
  };
  const reconciled = reconcileTopicOutput(topicOut, input.existingTopicSlugs);

  // 2. New-topic gate: drop near-duplicates + thin definitions.
  const newTopicsToCreate: GatedRecommendations['newTopicsToCreate'] = [];
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
    newTopicsToCreate.push({
      slug: proposal.slug,
      definition: proposal.definition,
      clusters: proposal.clusters ?? [],
    });
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

  // 4. Cite + related existence checks against the vault. Entities are NOT
  //    existence-filtered — apply upserts them, creating the page when the
  //    library meets the entity for the first time.
  const citeFilenames: string[] = [];
  for (const c of input.reviewer.cites) {
    if (await input.sourceExists(c.filename)) citeFilenames.push(c.filename);
  }
  const entities: GatedRecommendations['entities'] = [];
  for (const e of input.reviewer.entities) {
    if (entities.some((x) => x.slug === e.slug)) continue;
    entities.push({ slug: e.slug, name: e.name ?? null, kind: e.kind ?? null });
  }
  const relatedFilenames: string[] = [];
  for (const r of input.reviewer.related) {
    if (await input.sourceExists(r.filename)) relatedFilenames.push(r.filename);
  }

  return {
    existingTopicSlugs,
    newTopicsToCreate,
    citeFilenames,
    entities,
    relatedFilenames,
    gateStats: {
      foldedSlugs: reconciled.foldedSlugs.length,
      droppedHallucinations: reconciled.droppedHallucinations.length,
      rejectedNearDuplicates,
      rejectedThinDefinition,
      fuzzyCorrected,
    },
  };
}

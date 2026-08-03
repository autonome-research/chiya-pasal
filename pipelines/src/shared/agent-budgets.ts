/**
 * Output-token budgets for every agent call in the pipelines — one file.
 *
 * WHY THIS MODULE EXISTS
 *
 * A maxTokens cap is a constant tuned for one dependency state (which model
 * is behind the endpoint, how big the prompt is). When that state changes the
 * constant becomes silently wrong: nothing throws, the call just comes back
 * with finishReason='length' and the phase degrades. Four incidents in one
 * week traced to exactly this:
 *
 *  - digest classify/draft at 800/2500 — sized for non-reasoning gemma4:e4b.
 *    After the qwen3 switch the hidden reasoning pass ate the whole cap;
 *    classify force-skipped EVERY article and draft threw. Raised to 4000.
 *  - reviewer at a hardcoded 2500 — same root cause, missed in that fix, then
 *    made worse when Phase A added a 6k-char topic vocabulary to its prompt.
 *    31 articles deferred on 'truncated' in one evening; the vocabulary added
 *    to PREVENT uncategorized filings was causing them. Raised to 5000.
 *
 * The caps were not individually wrong so much as individually invisible:
 * each lived next to its call site, so a model swap had no single place to
 * look. Every budget now lives here with the reason it holds and the change
 * that would invalidate it, and __tests__/agent-budgets.test.ts fails the
 * build if a numeric maxTokens literal reappears at a call site.
 *
 * WHEN THE INFERENCE TARGET CHANGES, RE-READ THIS FILE. A reasoning model
 * spends the front of its budget on a hidden pass before emitting a single
 * output token, so a cap that was generous for a non-reasoning model of the
 * same size can be entirely consumed before the answer starts.
 */

export type AgentRole =
  | 'reviewer'
  | 'librarian-router'
  | 'topic-scout'
  | 'source-scout'
  | 'entity-scout'
  | 'cite-tracker'
  | 'digest-classify'
  | 'digest-draft'
  | 'shared-summarize'
  | 'cluster-backfill';

export interface AgentBudget {
  role: AgentRole;
  /** Effective cap for this process, after env override and floor. */
  value: number;
  /** Env var that overrides the default. */
  envVar: string;
  /** Lower bound applied via Math.max — an override below this is clamped. */
  floor: number;
  /** Compiled-in default, before any override. */
  fallback: number;
  /** `name` passed to runAgentWithTools, so a job event can be traced to a budget. */
  agentName: string;
  /** Why this number. */
  why: string;
  /** What change makes this number wrong. Check this list on any model swap. */
  invalidatedBy: string;
}

/**
 * Resolve one budget: env override, non-numeric/empty falls back, then floor.
 *
 * Semantics are deliberately identical to the inline
 * `Math.max(floor, Number(process.env.X ?? 'N') || N)` expressions this
 * module replaced, so the migration was bit-identical. Notably a garbage or
 * empty override yields the fallback (not NaN, not 0), and a negative or
 * absurdly small override is clamped up to the floor rather than honoured —
 * a typo'd env var must not be able to reintroduce the truncation failure.
 */
export function resolveBudget(
  envVar: string,
  fallback: number,
  floor: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.max(floor, Number(env[envVar] ?? String(fallback)) || fallback);
}

// ---------------------------------------------------------------------------
// Tools tier — librarian router, scouts, reviewer. qwen36 via the SSH tunnel,
// must support OpenAI tool calling.
// ---------------------------------------------------------------------------

/**
 * Reviewer: assigns an article against the topic vocabulary.
 *
 * 2500 was sized for a non-reasoning model and before the topic vocabulary
 * (up to 6k chars of slugs) entered the prompt: qwen3 reasons over which of
 * ~2.6k topics fit, and the hidden reasoning pass consumed the whole cap
 * before any JSON appeared — 31 articles deferred on `truncated` in one
 * evening, which is the very uncategorized-filing failure the vocabulary was
 * added to prevent.
 *
 * Invalidated by: a non-reasoning model on the tools tier (can go lower); a
 * larger `vocabularyForPrompt` char budget; any new section in the reviewer
 * prompt; a plan schema that grows the JSON the reviewer must emit.
 */
export const REVIEWER_MAX_TOKENS = resolveBudget('CHIYA_REVIEWER_MAX_TOKENS', 5000, 1000);

/**
 * Librarian router: one small triage JSON (which scouts to run), no tools.
 *
 * The smallest budget in the system and the one most exposed to a model
 * swap — the router's own answer is a few dozen tokens, so 800 is almost
 * entirely reasoning headroom. It survives on qwen36 because the routing
 * decision is shallow; a model that thinks harder here truncates first.
 *
 * Invalidated by: a more verbose reasoning model on the tools tier; adding
 * fields to the router's output schema; feeding the router the vocabulary.
 */
export const ROUTER_MAX_TOKENS = resolveBudget('CHIYA_ROUTER_MAX_TOKENS', 800, 256);

/**
 * Scouts (topic / source / entity / cite-tracker): explore one slice of the
 * vault over up to 10-12 tool rounds, then emit a bounded SurfacedPage list.
 *
 * 2000 is per assistant turn, not per session — the tool rounds each get a
 * fresh budget, so the cap only has to cover one round's reasoning plus
 * either a tool call or the final JSON of ~5 entries. The four scouts share
 * a value so the tools tier's cost per article stays predictable.
 *
 * Invalidated by: raising MAX_TOOL_ROUNDS (more rounds, same per-round cap,
 * so this stays right — but the session cost scales); raising the excerpt
 * length in the SurfacedPage contract; a scout asked to return more entries.
 */
export const TOPIC_SCOUT_MAX_TOKENS = resolveBudget('CHIYA_TOPIC_SCOUT_MAX_TOKENS', 2000, 512);
export const SOURCE_SCOUT_MAX_TOKENS = resolveBudget('CHIYA_SOURCE_SCOUT_MAX_TOKENS', 2000, 512);
export const ENTITY_SCOUT_MAX_TOKENS = resolveBudget('CHIYA_ENTITY_SCOUT_MAX_TOKENS', 2000, 512);
export const CITE_TRACKER_MAX_TOKENS = resolveBudget('CHIYA_CITE_TRACKER_MAX_TOKENS', 2000, 512);

// ---------------------------------------------------------------------------
// Fast tier — digest classify/draft, shared summarize, cluster backfill.
// JSON-only output, no tools.
// ---------------------------------------------------------------------------

/**
 * Shared default for the digest's fast-tier calls, and the back-compat home
 * of CHIYA_FAST_MAX_TOKENS.
 *
 * The original 800/2500 caps were sized for a non-reasoning model
 * (gemma4:e4b). Reasoning models emit a long hidden reasoning pass before the
 * final answer, so a small cap is consumed entirely by reasoning and the call
 * truncates before any JSON or section text is produced — classify then
 * force-skips every article and draft throws. 4000 matches the reviewer tier
 * and leaves ample room for reasoning plus the small classifier JSON or
 * section bullets.
 *
 * Invalidated by: a non-reasoning model on the fast tier (can go lower).
 */
export const FAST_MAX_TOKENS = resolveBudget('CHIYA_FAST_MAX_TOKENS', 4000, 256);

/**
 * Digest classify: one bucket assignment per article, ~100 tokens of JSON.
 *
 * Defaults to FAST_MAX_TOKENS so CHIYA_FAST_MAX_TOKENS keeps moving both
 * digest agents together, with CHIYA_DIGEST_CLASSIFY_MAX_TOKENS available to
 * split them if the two ever need different headroom.
 *
 * Invalidated by: whatever invalidates FAST_MAX_TOKENS; growing the
 * classifier system prompt's vault context.
 */
export const DIGEST_CLASSIFY_MAX_TOKENS = resolveBudget(
  'CHIYA_DIGEST_CLASSIFY_MAX_TOKENS',
  FAST_MAX_TOKENS,
  256,
);

/**
 * Digest draft: one section body of bullets. Largest genuine output on the
 * fast tier, and the one whose truncation is user-visible in the email.
 *
 * 8000, not FAST_MAX_TOKENS: the truncation audit's first live run measured
 * draft-sections hitting its ceiling in 9 of 12 recent runs (75%) at 4000.
 * The retry ladder hid it — every one of those runs silently paid for a
 * second call at double the budget, and a section that truncated twice fell
 * back to deterministic rendering. A budget whose escalation rung is the
 * normal path is not a budget.
 *
 * Invalidated by: whatever invalidates FAST_MAX_TOKENS; more articles per
 * section bucket; a section contract that asks for prose instead of bullets.
 */
export const DIGEST_DRAFT_MAX_TOKENS = resolveBudget(
  'CHIYA_DIGEST_DRAFT_MAX_TOKENS',
  // Floor, not replacement: CHIYA_FAST_MAX_TOKENS still raises draft with the
  // rest of the fast tier, it just cannot drop it back under the measured
  // truncation threshold.
  Math.max(FAST_MAX_TOKENS, 8000),
  256,
);

/**
 * Draft's escalation ladder. Truncation must never sink the whole digest, so
 * the section is retried once at double the budget before falling back to a
 * deterministic rendering of the classifier output. The doubling is the
 * backstop that kept the digest alive through incident 1 — it degraded the
 * sections instead of failing the run, which is also why the bad cap went
 * unnoticed for weeks. Treat a run that reaches the second rung at all as a
 * signal that DIGEST_DRAFT_MAX_TOKENS is stale.
 */
export const DIGEST_DRAFT_LADDER: readonly number[] = [
  DIGEST_DRAFT_MAX_TOKENS,
  DIGEST_DRAFT_MAX_TOKENS * 2,
];

/**
 * Shared summarize: the rich structured summary written once per article for
 * every tenant, so a truncated one is the most expensive kind of bad output.
 *
 * Deliberately well past any sane summary — this cap is a runaway-output
 * backstop, not a fit to the expected length, and the phase throws on
 * truncation rather than storing a cut-off summary. Do not "tune it down" to
 * the observed p99; the point is that only genuine runaway trips it.
 *
 * Invalidated by: growing the summary schema; raising INPUT_CAP_CHARS enough
 * that the model starts summarizing proportionally longer.
 */
export const SHARED_SUMMARIZE_MAX_TOKENS = resolveBudget(
  'CHIYA_SHARED_SUMMARIZE_MAX_TOKENS',
  8000,
  1024,
);

/**
 * Cluster backfill (scripts/backfill-clusters-llm.ts): one batch of ~30
 * topics per call.
 *
 * A 30-topic batch answers in roughly 1.5 KB of JSON, but the fast tier is a
 * reasoning model that spends the first chunk of its budget thinking — an
 * undersized cap truncates before any JSON appears and every batch is
 * skipped silently. Sized with headroom above the digest tier because the
 * output is 30 answers, not one.
 *
 * Invalidated by: raising the batch size; a non-reasoning fast tier.
 */
export const CLUSTER_BACKFILL_MAX_TOKENS = resolveBudget(
  'CHIYA_CLUSTER_BACKFILL_MAX_TOKENS',
  6000,
  1024,
);

// ---------------------------------------------------------------------------
// Registry — enumerable surface for tests and doctor. Every agent role that
// passes maxTokens to runAgentWithTools must appear here.
// ---------------------------------------------------------------------------

/**
 * Every output-token budget in the system, keyed by role.
 *
 * `agentName` is the `name` passed to runAgentWithTools, which is what lands
 * in the JobStore event log — so an operator seeing repeated
 * finishReason='length' on agent X can look up X's budget here without
 * grepping the phases. Doctor enumerates this to report the effective caps
 * and which of them are currently env-overridden.
 */
export const AGENT_BUDGETS: Record<AgentRole, AgentBudget> = {
  reviewer: {
    role: 'reviewer',
    value: REVIEWER_MAX_TOKENS,
    envVar: 'CHIYA_REVIEWER_MAX_TOKENS',
    floor: 1000,
    fallback: 5000,
    agentName: 'reviewer',
    why: 'reasoning model + up to 6k chars of topic vocabulary in the prompt',
    invalidatedBy: 'non-reasoning tools tier; larger vocabulary budget; wider plan schema',
  },
  'librarian-router': {
    role: 'librarian-router',
    value: ROUTER_MAX_TOKENS,
    envVar: 'CHIYA_ROUTER_MAX_TOKENS',
    floor: 256,
    fallback: 800,
    agentName: 'librarian-router',
    why: 'tiny triage JSON; almost all of it is reasoning headroom',
    invalidatedBy: 'a more verbose reasoning model; more fields in the router output',
  },
  'topic-scout': {
    role: 'topic-scout',
    value: TOPIC_SCOUT_MAX_TOKENS,
    envVar: 'CHIYA_TOPIC_SCOUT_MAX_TOKENS',
    floor: 512,
    fallback: 2000,
    agentName: 'topic-scout',
    why: 'per tool round: one round of reasoning plus a tool call or ~5 SurfacedPages',
    invalidatedBy: 'longer excerpts; more entries per scout; non-reasoning tools tier',
  },
  'source-scout': {
    role: 'source-scout',
    value: SOURCE_SCOUT_MAX_TOKENS,
    envVar: 'CHIYA_SOURCE_SCOUT_MAX_TOKENS',
    floor: 512,
    fallback: 2000,
    agentName: 'source-scout',
    why: 'per tool round: one round of reasoning plus a tool call or ~5 SurfacedPages',
    invalidatedBy: 'longer excerpts; more entries per scout; non-reasoning tools tier',
  },
  'entity-scout': {
    role: 'entity-scout',
    value: ENTITY_SCOUT_MAX_TOKENS,
    envVar: 'CHIYA_ENTITY_SCOUT_MAX_TOKENS',
    floor: 512,
    fallback: 2000,
    agentName: 'entity-scout',
    why: 'per tool round: one round of reasoning plus a tool call or ~5 SurfacedPages',
    invalidatedBy: 'longer excerpts; more entries per scout; non-reasoning tools tier',
  },
  'cite-tracker': {
    role: 'cite-tracker',
    value: CITE_TRACKER_MAX_TOKENS,
    envVar: 'CHIYA_CITE_TRACKER_MAX_TOKENS',
    floor: 512,
    fallback: 2000,
    agentName: 'cite-tracker',
    why: 'per tool round: one round of reasoning plus a tool call or ~5 SurfacedPages',
    invalidatedBy: 'longer excerpts; more entries per scout; non-reasoning tools tier',
  },
  'digest-classify': {
    role: 'digest-classify',
    value: DIGEST_CLASSIFY_MAX_TOKENS,
    envVar: 'CHIYA_DIGEST_CLASSIFY_MAX_TOKENS',
    floor: 256,
    fallback: FAST_MAX_TOKENS,
    agentName: 'classifier',
    why: 'reasoning pass on the fast tier dwarfs the ~100-token bucket JSON',
    invalidatedBy: 'non-reasoning fast tier; a larger vault context in the classifier prompt',
  },
  'digest-draft': {
    role: 'digest-draft',
    value: DIGEST_DRAFT_MAX_TOKENS,
    envVar: 'CHIYA_DIGEST_DRAFT_MAX_TOKENS',
    floor: 256,
    fallback: FAST_MAX_TOKENS,
    agentName: 'drafter',
    why: 'reasoning pass plus a full section of bullets; retried once at 2x',
    invalidatedBy: 'non-reasoning fast tier; more articles per bucket; prose sections',
  },
  'shared-summarize': {
    role: 'shared-summarize',
    value: SHARED_SUMMARIZE_MAX_TOKENS,
    envVar: 'CHIYA_SHARED_SUMMARIZE_MAX_TOKENS',
    floor: 1024,
    fallback: 8000,
    agentName: 'shared-summarize',
    why: 'runaway-output backstop, not a fit to expected length; phase throws on truncation',
    invalidatedBy: 'a wider summary schema; a much larger INPUT_CAP_CHARS',
  },
  'cluster-backfill': {
    role: 'cluster-backfill',
    value: CLUSTER_BACKFILL_MAX_TOKENS,
    envVar: 'CHIYA_CLUSTER_BACKFILL_MAX_TOKENS',
    floor: 1024,
    fallback: 6000,
    agentName: 'cluster-backfill',
    why: '~30 topic answers (~1.5 KB JSON) behind a reasoning pass',
    invalidatedBy: 'a larger batch size; a non-reasoning fast tier',
  },
};

/** Budgets currently raised or lowered by an env var, for doctor to surface. */
export function overriddenBudgets(env: NodeJS.ProcessEnv = process.env): AgentBudget[] {
  return Object.values(AGENT_BUDGETS).filter((b) => env[b.envVar] !== undefined);
}

#!/usr/bin/env tsx
/**
 * Assign `clusters:` frontmatter to topic pages that have none, using the fast
 * inference tier — LLM proposes, this script disposes.
 *
 * The deterministic sibling (`backfill-topic-clusters.ts`) recovers clusters
 * from git history: it maps a slug back to the domain directory it was born
 * under, before the flattening migration. That signal only exists for pages
 * that were ever nested, and in the live vault it recovered 6 of 1,444 — the
 * rest were born flat and git has nothing to say about them. There is no
 * deterministic source left, so the remainder needs judgement: a model reads
 * the topic's title and definition and picks from the vocabulary the vault
 * already uses.
 *
 * Everything the model touches is bounded:
 *
 *   - it may only choose from cluster names ALREADY IN USE in this vault
 *     (canonicalized through CLUSTER_ALIASES, below). New cluster invention is
 *     rejected, not merged — clusters are soft metadata whose value comes from
 *     agreement, and a one-off label is worse than no label.
 *   - 0-2 clusters per topic. Empty is a legitimate, expected answer.
 *   - output is JSON validated with the shared validators; unknown labels are
 *     dropped and counted, slugs not in the batch are ignored.
 *   - truncation (`finishReason: 'length'`) and transport errors fail the
 *     BATCH, not the run — the batch is skipped and the run continues. The
 *     script is rerunnable, so a skipped batch is picked up next pass.
 *
 * Writes go through `injectClusters` from `backfill-topic-clusters.ts` (the
 * same helper the git-history backfill uses — deliberately imported, not
 * forked), which is only-if-empty by construction: a page that already carries
 * a `clusters:` key comes back unchanged and is not written. That makes the
 * whole script idempotent and safe to re-run after a partial failure.
 *
 * Usage:
 *   tsx scripts/backfill-clusters-llm.ts --user <handle>             # dry run
 *   tsx scripts/backfill-clusters-llm.ts --user <handle> --execute   # write
 *
 * Dry run is the default: it prints the per-batch assignments and a cluster
 * histogram and writes nothing. Execute mode writes page files but never
 * touches git — committing is the operator's call (or the next lint run's).
 *
 * The final stdout line is a JSON summary (machine-readable; tests parse it),
 * matching the repair-script convention.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import OpenAI from 'openai';
import { runAgentWithTools, type ToolExecutor } from 'thread-phase';

import { CLUSTER_BACKFILL_MAX_TOKENS } from '../src/shared/agent-budgets.js';
import { loadChiyaEnvFor, type InferenceTarget } from '../src/shared/env.js';
import {
  invalid,
  isRecord,
  parseAndValidateJson,
  stringArray,
  valid,
  type Validator,
} from '../src/shared/llm-schema.js';
import { scanTopicRegistry, type TopicRecord, type TopicRegistry } from '../src/shared/topic-registry.js';
import { injectClusters } from './backfill-topic-clusters.js';

// ---- canonical vocabulary -------------------------------------------------

/**
 * Canonical name for known-noisy legacy cluster labels.
 *
 * These pairs are already both present in the live vault (3 pages on
 * `security` vs 64 on `cybersecurity`, 16 on `space` vs 8 on `aerospace`), so
 * offering the raw in-use set to the model would let it deepen a split the
 * vault does not want. The map is applied to BOTH sides: the allowed set the
 * model sees is canonicalized, and whatever the model returns is canonicalized
 * again before validation. It is intentionally tiny and visible — it is a
 * spelling fix, not a taxonomy. Anything not listed here passes through
 * untouched.
 *
 * Note this only affects clusters this script writes; it never rewrites a
 * cluster already on a page.
 */
export const CLUSTER_ALIASES: Readonly<Record<string, string>> = {
  bio: 'biology',
  security: 'cybersecurity',
  space: 'aerospace',
};

/** Lowercase, whitespace/underscores to hyphens, then alias to canonical. */
export function normalizeClusterLabel(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return CLUSTER_ALIASES[slug] ?? slug;
}

/**
 * The label set the model may choose from: every cluster name in use in this
 * vault, canonicalized and deduped, ordered by how many topics carry it
 * (descending, then alphabetically).
 *
 * Ordering is load-bearing: the prompt lists the vocabulary in this order, so
 * a model that pattern-matches the head of the list lands on the vault's big
 * clusters rather than its long tail of singletons.
 */
export function allowedClusterLabels(reg: TopicRegistry): string[] {
  const counts = new Map<string, number>();
  for (const [name, { topicCount }] of Object.entries(reg.clusters)) {
    const canon = normalizeClusterLabel(name);
    if (canon.length === 0) continue;
    counts.set(canon, (counts.get(canon) ?? 0) + topicCount);
  }
  return [...counts.keys()].sort((a, b) => {
    const ca = counts.get(a)!;
    const cb = counts.get(b)!;
    if (cb !== ca) return cb - ca;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Topics with no clusters at all, most-connected first.
 *
 * Ordering is by member count so `--limit` spends a partial run on the pages
 * that matter most (a 300-source topic missing from every cluster hides more
 * of the vault than a 0-source stub), and so repeated runs are deterministic.
 */
export function unclusteredTopics(reg: TopicRegistry): TopicRecord[] {
  return reg.topics
    .filter((t) => t.clusters.length === 0)
    .sort((a, b) => {
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      if (b.citedByTotal !== a.citedByTotal) return b.citedByTotal - a.citedByTotal;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
}

export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// ---- prompt ---------------------------------------------------------------

/** How much of a topic's one-liner definition the prompt carries. */
const DEFINITION_CHARS = 240;

/** Hard cap on clusters per topic, enforced on output regardless of the prompt. */
export const MAX_CLUSTERS_PER_TOPIC = 2;

export function buildSystemPrompt(allowed: string[]): string {
  return `You are assigning soft cluster labels to topic pages in a research wiki.

Clusters are overlapping, soft metadata — a loose "which corner of the library is this in" signal. They are NOT a taxonomy, NOT a hierarchy, and NOT required: many topics legitimately have none.

Choose ONLY from this exact list of clusters already used in this library, most-used first:
${allowed.join(', ')}

Rules:
- Assign 0, 1, or ${MAX_CLUSTERS_PER_TOPIC} clusters per topic. Never more than ${MAX_CLUSTERS_PER_TOPIC}.
- NEVER invent a cluster name. If nothing in the list fits, return an empty array. An empty array is a good answer and is expected often.
- Copy names verbatim from the list. Do not pluralize, expand, translate, or coin variants.
- Assign a cluster only when the topic clearly belongs to it. Prefer fewer, confident labels over broad guessing.

Reply ONLY with JSON of the form:
{"assignments": [{"slug": "<topic-slug>", "clusters": ["<cluster>", ...]}, ...]}

Include every slug you were given, in the order given. No prose, no markdown fences.`;
}

export function buildBatchUserMessage(batch: TopicRecord[]): string {
  const lines = batch.map((t) => {
    const definition = (t.oneLiner ?? '').trim().slice(0, DEFINITION_CHARS);
    return `- slug: ${t.slug}\n  title: ${t.title}\n  definition: ${definition || '(none)'}`;
  });
  return `Assign clusters to these ${batch.length} topics:\n\n${lines.join('\n')}`;
}

// ---- output validation ----------------------------------------------------

interface RawAssignment {
  slug: string;
  clusters: string[];
}

/**
 * Shape-only validation: slugs and labels are still untrusted strings here and
 * are checked against the batch and the allowed vocabulary in
 * `resolveAssignments`. Splitting the two keeps "the model answered in the
 * right shape" separate from "the model answered with real names", which is
 * the difference between a broken endpoint and a hallucinating one.
 */
export const validateAssignments: Validator<RawAssignment[]> = (value) => {
  if (!isRecord(value)) return invalid('not-an-object');
  if (!Array.isArray(value.assignments)) return invalid('assignments-not-an-array');
  const out: RawAssignment[] = [];
  for (const entry of value.assignments) {
    if (!isRecord(entry)) continue;
    if (typeof entry.slug !== 'string' || entry.slug.trim() === '') continue;
    out.push({
      slug: entry.slug.trim(),
      // Read generously (8) and cap later, so an over-eager answer is trimmed
      // to the best two rather than thrown away entirely.
      clusters: stringArray(entry.clusters, 8),
    });
  }
  return valid(out);
};

export interface ResolvedAssignment {
  slug: string;
  clusters: string[];
}

export interface ResolveResult {
  assignments: ResolvedAssignment[];
  /** Labels the model proposed that are not in the allowed vocabulary. */
  droppedLabels: string[];
  /** Slugs returned that were not in the batch (hallucinated or duplicated). */
  droppedSlugs: string[];
}

/**
 * Reduce the model's proposal to what code is willing to write.
 *
 * Every rejection is counted rather than silently swallowed: a run whose
 * dropped-label count is high is a run whose prompt or vocabulary needs work,
 * and the summary line is where the operator sees that.
 */
export function resolveAssignments(
  batch: TopicRecord[],
  raw: RawAssignment[],
  allowed: string[],
): ResolveResult {
  const allowedSet = new Set(allowed);
  const inBatch = new Set(batch.map((t) => t.slug));
  const seen = new Set<string>();

  const assignments: ResolvedAssignment[] = [];
  const droppedLabels: string[] = [];
  const droppedSlugs: string[] = [];

  for (const entry of raw) {
    const slug = entry.slug;
    if (!inBatch.has(slug) || seen.has(slug)) {
      droppedSlugs.push(slug);
      continue;
    }
    seen.add(slug);

    const clusters: string[] = [];
    for (const label of entry.clusters) {
      const canon = normalizeClusterLabel(label);
      if (canon.length === 0) continue;
      if (!allowedSet.has(canon)) {
        droppedLabels.push(label);
        continue;
      }
      if (clusters.includes(canon)) continue;
      if (clusters.length >= MAX_CLUSTERS_PER_TOPIC) {
        droppedLabels.push(label);
        continue;
      }
      clusters.push(canon);
    }
    if (clusters.length > 0) assignments.push({ slug, clusters });
  }

  // Deterministic order regardless of the order the model answered in.
  const rank = new Map(batch.map((t, i) => [t.slug, i]));
  assignments.sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!);
  return { assignments, droppedLabels, droppedSlugs };
}

// ---- inference seam -------------------------------------------------------

/**
 * The only LLM-shaped thing in this module. Tests pass a fake; the CLI passes
 * `makeClusterAgentFn(client, model)`.
 */
export type ClusterAgentFn = (
  systemPrompt: string,
  userMessage: string,
) => Promise<{ text: string; finishReason: string | null }>;

/**
 * Back-compat alias. The budget itself, and the reason it is 6000, now live
 * with every other agent budget in src/shared/agent-budgets.ts.
 * CHIYA_CLUSTER_BACKFILL_MAX_TOKENS still overrides it.
 */
export const CLUSTER_MAX_TOKENS = CLUSTER_BACKFILL_MAX_TOKENS;

// This agent classifies and has no callable tools.
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

export function makeClusterAgentFn(client: OpenAI, model: string): ClusterAgentFn {
  return async (systemPrompt, userMessage) => {
    const r = await runAgentWithTools(
      {
        name: 'cluster-backfill',
        systemPrompt,
        model,
        tools: [],
        maxToolRounds: 1,
        maxTokens: CLUSTER_BACKFILL_MAX_TOKENS,
      },
      [{ role: 'user', content: userMessage }],
      { client, toolExecutor: noTools },
    );
    return { text: r.text, finishReason: r.finishReason ?? null };
  };
}

// ---- per-batch classification ---------------------------------------------

export interface BatchResult {
  ok: boolean;
  /** Empty when `ok` is false. */
  assignments: ResolvedAssignment[];
  droppedLabels: string[];
  droppedSlugs: string[];
  /** Why the batch failed; null when it succeeded. */
  reason: string | null;
}

function failedBatch(reason: string): BatchResult {
  return { ok: false, assignments: [], droppedLabels: [], droppedSlugs: [], reason };
}

/**
 * Classify one batch. Never throws: a transient failure (transport error,
 * truncation, unparseable output) degrades to a skipped batch so the rest of
 * the run continues. Skipped topics keep their empty `clusters:` and are
 * simply picked up by the next run.
 */
export async function classifyBatch(
  batch: TopicRecord[],
  allowed: string[],
  agentFn: ClusterAgentFn,
): Promise<BatchResult> {
  if (batch.length === 0) return { ok: true, assignments: [], droppedLabels: [], droppedSlugs: [], reason: null };

  let result: { text: string; finishReason: string | null };
  try {
    result = await agentFn(buildSystemPrompt(allowed), buildBatchUserMessage(batch));
  } catch (err) {
    return failedBatch(`transport-error:${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.finishReason === 'error') return failedBatch('agent-error');
  if (result.finishReason === 'length') return failedBatch('truncated');

  const parsed = parseAndValidateJson(result.text, validateAssignments);
  if (!parsed.ok) return failedBatch(parsed.reason);

  const resolved = resolveAssignments(batch, parsed.value, allowed);
  return { ok: true, ...resolved, reason: null };
}

// ---- writing --------------------------------------------------------------

export interface WriteResult {
  written: number;
  /** Pages that gained a `clusters:` key on an earlier run (or concurrently). */
  skippedUnchanged: number;
  /** Pages that could not be read. */
  missing: number;
}

/**
 * Write assignments to disk, only-if-empty.
 *
 * `injectClusters` returns the text unchanged when a `clusters:` key already
 * exists, so a re-run after a partial failure re-proposes but never overwrites
 * — and the unchanged text is compared before writing, so an unchanged page is
 * not touched at all (same content-compared-write discipline as lint).
 */
export function applyAssignments(topicsDir: string, assignments: ResolvedAssignment[]): WriteResult {
  let written = 0;
  let skippedUnchanged = 0;
  let missing = 0;

  for (const a of assignments) {
    const path = join(topicsDir, `${a.slug}.md`);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      missing++;
      continue;
    }
    const updated = injectClusters(text, a.clusters);
    if (updated === text) {
      skippedUnchanged++;
      continue;
    }
    writeFileSync(path, updated);
    written++;
  }
  return { written, skippedUnchanged, missing };
}

// ---- run ------------------------------------------------------------------

export interface RunOptions {
  topicsDir: string;
  targets: TopicRecord[];
  allowed: string[];
  batchSize: number;
  execute: boolean;
  agentFn: ClusterAgentFn;
  log?: (line: string) => void;
}

export interface RunSummary {
  mode: 'EXECUTE' | 'dry-run';
  targets: number;
  batches: number;
  batchesFailed: number;
  topicsAssigned: number;
  topicsUnassigned: number;
  labelsDropped: number;
  slugsDropped: number;
  pagesWritten: number;
  pagesSkippedUnchanged: number;
  pagesMissing: number;
  histogram: Record<string, number>;
  failures: string[];
}

const LOG_TAG = '[backfill-clusters-llm]';

/**
 * Batch → classify → (optionally) write. Batches run serially: this is a
 * one-shot backfill against the same inference endpoint the live pipelines
 * share, and finishing an hour sooner is not worth competing with the
 * librarian for it.
 */
export async function runBackfill(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const batches = chunk(opts.targets, opts.batchSize);

  const histogram: Record<string, number> = {};
  const failures: string[] = [];
  const accepted: ResolvedAssignment[] = [];
  let labelsDropped = 0;
  let slugsDropped = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const result = await classifyBatch(batch, opts.allowed, opts.agentFn);
    if (!result.ok) {
      failures.push(`batch ${i + 1}: ${result.reason}`);
      log(`${LOG_TAG} batch ${i + 1}/${batches.length} (${batch.length} topics) SKIPPED — ${result.reason}`);
      continue;
    }

    labelsDropped += result.droppedLabels.length;
    slugsDropped += result.droppedSlugs.length;
    for (const a of result.assignments) {
      accepted.push(a);
      for (const c of a.clusters) histogram[c] = (histogram[c] ?? 0) + 1;
    }

    log(
      `${LOG_TAG} batch ${i + 1}/${batches.length}: ${result.assignments.length}/${batch.length} assigned` +
        `, ${result.droppedLabels.length} label(s) dropped`,
    );
    for (const a of result.assignments) {
      log(`  ${a.slug} → clusters: [${a.clusters.join(', ')}]`);
    }
  }

  let write: WriteResult = { written: 0, skippedUnchanged: 0, missing: 0 };
  if (opts.execute) {
    write = applyAssignments(opts.topicsDir, accepted);
  }

  const ordered: Record<string, number> = {};
  for (const name of Object.keys(histogram).sort((a, b) => {
    const d = histogram[b]! - histogram[a]!;
    return d !== 0 ? d : a < b ? -1 : 1;
  })) {
    ordered[name] = histogram[name]!;
  }

  return {
    mode: opts.execute ? 'EXECUTE' : 'dry-run',
    targets: opts.targets.length,
    batches: batches.length,
    batchesFailed: failures.length,
    topicsAssigned: accepted.length,
    topicsUnassigned: opts.targets.length - accepted.length,
    labelsDropped,
    slugsDropped,
    pagesWritten: write.written,
    pagesSkippedUnchanged: write.skippedUnchanged,
    pagesMissing: write.missing,
    histogram: ordered,
    failures,
  };
}

// ---- CLI ------------------------------------------------------------------

interface Args {
  user: string;
  execute: boolean;
  batchSize: number;
  limit: number | null;
}

const DEFAULT_BATCH_SIZE = 30;

function aliasHelp(): string {
  return Object.entries(CLUSTER_ALIASES)
    .map(([from, to]) => `${from} → ${to}`)
    .join(', ');
}

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error(`Usage: tsx scripts/backfill-clusters-llm.ts --user <handle> [options]

Assigns 'clusters:' frontmatter to topic pages that have none, using the fast
inference tier. The model may only pick from cluster names already in use in
the vault; unknown labels are dropped, never created.

Options:
  --user <handle>     Tenant whose vault to backfill (required)
  --execute           Write the assignments (default: dry run, prints only)
  --batch-size <n>    Topics per LLM call (default: ${DEFAULT_BATCH_SIZE})
  --limit <n>         Only process the first n unclustered topics
                      (ordered by member count, so a partial run covers the
                      most-connected topics first)
  --help              This message

Canonical name normalization applied to the allowed vocabulary AND to model
output (see CLUSTER_ALIASES):
  ${aliasHelp()}

Only-if-empty: a page that already has a 'clusters:' key is never rewritten,
so the script is idempotent and safe to re-run after a partial failure.
Writes page files only — git is left untouched.
`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  let user: string | null = null;
  let execute = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let limit: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg.startsWith('--') ? arg.slice(2).split('=')[0]! : null;
    const value = (): string => {
      const eq = arg.indexOf('=');
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) usage(2, `--${flag} requires a value`);
      return next;
    };
    const positive = (name: string): number => {
      const n = Number.parseInt(value(), 10);
      if (!Number.isFinite(n) || n <= 0) usage(2, `--${name} must be a positive integer`);
      return n;
    };
    switch (flag) {
      case 'user':
        user = value();
        break;
      case 'execute':
        execute = true;
        break;
      case 'batch-size':
        batchSize = positive('batch-size');
        break;
      case 'limit':
        limit = positive('limit');
        break;
      case 'help':
        usage(0);
        break;
      default:
        usage(2, `unknown argument: ${arg}`);
    }
  }
  if (!user) usage(2, '--user <handle> is required');
  return { user, execute, batchSize, limit };
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadChiyaEnvFor(args.user);

  console.log(
    `${LOG_TAG} user=${args.user} vault=${env.vaultDir} fast=${env.fast.baseUrl}/${env.fast.model} ` +
      `mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'}`,
  );

  const reg = scanTopicRegistry(env.vaultDir, new Date().toISOString());
  const allowed = allowedClusterLabels(reg);
  const all = unclusteredTopics(reg);
  const targets = args.limit === null ? all : all.slice(0, args.limit);

  console.log(
    `${LOG_TAG} topics=${reg.topics.length} unclustered=${all.length} targets=${targets.length} ` +
      `vocabulary=${allowed.length} batch-size=${args.batchSize}`,
  );
  console.log(`${LOG_TAG} allowed clusters: ${allowed.join(', ')}`);

  const summary = await runBackfill({
    topicsDir: join(env.vaultDir, 'wiki', 'topics'),
    targets,
    allowed,
    batchSize: args.batchSize,
    execute: args.execute,
    agentFn: makeClusterAgentFn(clientFor(env.fast), env.fast.model),
  });

  const hist = Object.entries(summary.histogram);
  console.log(`${LOG_TAG} cluster histogram (${hist.length} clusters used):`);
  for (const [name, count] of hist) console.log(`  ${name}: ${count}`);

  if (args.execute) {
    console.log(
      `${LOG_TAG} wrote ${summary.pagesWritten} page(s); ` +
        `${summary.pagesSkippedUnchanged} already clustered, ${summary.pagesMissing} missing. ` +
        `git left untouched.`,
    );
  } else {
    console.log(`${LOG_TAG} dry run — no files written. Re-run with --execute.`);
  }

  console.log(JSON.stringify(summary));
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-clusters-llm.ts') ||
  process.argv[1]?.endsWith('backfill-clusters-llm.js');

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`${LOG_TAG} fatal:`, err);
    process.exit(1);
  });
}

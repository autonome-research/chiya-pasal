/**
 * Digest pipeline entry point.
 *
 * Multi-tenant: iterates over enabled users from config/users.yaml, one
 * sequential digest per user against that user's DB, vault, git remote, and
 * email address, each behind its own job lock (chiya-digest:<handle>). One
 * user's failure never blocks the others. Without users.yaml it falls back
 * to the legacy single-tenant env.
 *
 * Usage: tsx src/digest.ts {AM|PM} [--user=<handle>]
 *
 * Composes phases from src/phases/digest-phases.ts, runs them through
 * thread-phase's JobRunner + SqliteJobStore so every event is persisted
 * (resumable inspection of past runs via the sqlite log).
 */

import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
} from 'thread-phase';
import OpenAI from 'openai';

import { ArticleStore } from './shared/article-store.js';
import {
  resolveTenantTargets,
  type ChiyaEnv,
  type InferenceTarget,
  type TenantTarget,
} from './shared/env.js';
import { installShutdownHandlers } from './shared/shutdown.js';
/** Reclaim RUNNING jobs whose owner has been silent this long. Heartbeats
 *  fire every 30s, so 5 minutes of silence means the process is gone. */
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
import { VaultMutationLock, withVaultMutationLock } from './shared/vault-mutation-lock.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';
import {
  appendLog,
  assemble,
  commitDigest,
  draftSections,
  emailSend,
  loadArticles,
  loadContext,
  prioritize,
  squashAndPush,
} from './phases/digest-phases.js';
// The AM/PM consumption ledger: load-articles fills the selection, email-send
// stamps it. Imported from the leaf module because it is plumbing between two
// phases rather than a phase itself.
import { createDigestSelection } from './phases/digest/load-articles.js';
import type { DigestCtx, DigestDirection } from './shared/digest-types.js';

function todayLocal(): string {
  // Local calendar day, not UTC. The digest's systemd timers fire at local
  // 06:30 / 18:30; the human-facing "today" should match the user's wall
  // clock, and ArticleStore.listByLocalDate translates this into the right
  // UTC range for the query against collected_at.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface Args {
  direction: DigestDirection;
  user?: string;
}

function parseArgs(): Args {
  const [directionArg, ...rest] = process.argv.slice(2);
  if (directionArg !== 'AM' && directionArg !== 'PM') {
    console.error('Usage: digest.ts {AM|PM} [--user=<handle>]');
    process.exit(2);
  }
  let user: string | undefined;
  for (const arg of rest) {
    const kv = /^--user=(.+)$/.exec(arg);
    if (!kv) {
      console.error(`unknown digest argument: ${arg}`);
      process.exit(2);
    }
    user = kv[1]!;
  }
  return { direction: directionArg, user };
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

type RunStatus = 'COMPLETED' | 'FAILED' | 'SKIPPED';

/** One full digest run against one tenant's env. */
async function runForTenant(
  label: string,
  env: ChiyaEnv,
  direction: DigestDirection,
  localDate: string,
): Promise<RunStatus> {
  const tag = `[digest:${label}]`;
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const lockName = env.userHandle ? `chiya-digest:${env.userHandle}` : 'chiya-digest';

  console.log(
    `${tag} direction=${direction} vault=${env.vaultDir} to=${env.emailTo} fast=${env.fast.baseUrl}/${env.fast.model}`,
  );

  const vault = new VaultFs(env.vaultDir);
  const git = new GitOps({ vaultDir: env.vaultDir, remote: env.vaultRemote, branch: env.vaultBranch });
  const vaultMutationLock = new VaultMutationLock({ vaultDir: env.vaultDir });
  // Digest has no tool calls — everything routes through the fast client.
  const fastClient = clientFor(env.fast);
  const articleStore = new ArticleStore(dbPath);
  const store = new SqliteJobStore(dbPath);
  const runner = new JobRunner(store, { heartbeatMs: 30_000 });

  // Articles this run consumed. Stamped digested_at by email-send on success,
  // so the PM run sees only what arrived after the AM mail went out — and a
  // failed send leaves everything eligible for the next firing.
  const selection = createDigestSelection();

  const phases = [
    loadContext(vault, env.interests),
    loadArticles(articleStore, selection),
    prioritize(fastClient, env.fast.model),
    draftSections(fastClient, env.fast.model),
    assemble,
    withVaultMutationLock(
      vaultMutationLock,
      [appendLog(vault), commitDigest(git), squashAndPush(git)],
      'digest-vault-mutation',
    ),
    emailSend(env, { digested: { store: articleStore, selection } }),
  ];

  const runController = new AbortController();
  const ctx: DigestCtx = {
    cache: new PipelineCache(),
    direction,
    date: localDate,
    signal: runController.signal,
  };

  try {
    // Reclaim jobs whose owner stopped heartbeating. Without this, a single
    // crash mid-digest leaves the lock RUNNING forever and every subsequent
    // timer firing exits clean — the May-12 → May-17 five-day digest outage
    // was exactly that scenario (then wall-clock-swept; now heartbeat-based).
    const reclaimed = await runner.reconcileAbandoned(STALE_HEARTBEAT_MS);
    if (reclaimed.length > 0) console.log(`${tag} reclaimed ${reclaimed.length} abandoned job(s)`);

    // acquireExclusive: prevent overlapping digest runs (e.g. an AM run that
    // overruns into PM) from racing on git/email side effects.
    const jobId = await store.acquireExclusive(lockName, { direction, date: localDate });
    if (!jobId) {
      console.log(`${tag} another digest run is already in flight — skipping`);
      return 'SKIPPED';
    }

    // Mirror events to stdout for live observation under systemd journal.
    runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) => {
      console.log(`[event:${e.eventType}]`, JSON.stringify(e.data));
    });

    const disposeShutdown = installShutdownHandlers(`digest:${label}`, (signal) => {
      if (!runController.signal.aborted) runController.abort(`received ${signal}`);
      runner.cancel(jobId, `received ${signal}`);
    });

    try {
      await runner.run(jobId, phases, ctx, () => ({
        user: env.userHandle,
        direction: ctx.direction,
        date: ctx.date,
        articleCount: ctx.articles?.length ?? 0,
        highlighted: ctx.classified?.filter((c) => c.bucket !== 'skip').length ?? 0,
        pushed: ctx.pushed,
        emailed: ctx.emailed,
      }));
    } finally {
      disposeShutdown();
    }

    const final = await store.getJob(jobId);
    console.log(`${tag} job ${jobId} → ${final?.status}`);
    if (final?.status === 'FAILED') {
      console.error(`${tag} error: ${final.error}`);
      return 'FAILED';
    }
    return 'COMPLETED';
  } finally {
    articleStore.close();
    store.close();
  }
}

async function main(): Promise<void> {
  const { direction, user } = parseArgs();
  const localDate = todayLocal();
  const targets: TenantTarget[] = resolveTenantTargets(user);

  let anyFailed = false;
  for (const target of targets) {
    const label = target.handle ?? 'default';
    try {
      const status = await runForTenant(label, target.env, direction, localDate);
      if (status === 'FAILED') anyFailed = true;
    } catch (err) {
      console.error(`[digest:${label}] fatal:`, err);
      anyFailed = true;
    }
  }
  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error('[digest] fatal:', err);
  process.exit(1);
});

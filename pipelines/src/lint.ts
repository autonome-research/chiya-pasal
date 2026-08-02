/**
 * Lint entry point. The lint pipeline is the vault's "organize" organ: it
 * resolves external references whose paper has since landed into real cites,
 * regenerates the derived views (topic registry, index, graph), corrects the
 * counters the writers cannot maintain incrementally (`cited_by`), re-orders
 * topic member lists by importance, and reports structural problems (broken
 * links, orphans, stubs, near-duplicate topics) without acting on them.
 *
 * Every pass is deterministic — no LLM is involved anywhere in this pipeline.
 * Judgment-driven cleanup (merges, deletions) is a later phase and will still
 * land as proposals for deterministic code to dispose of.
 *
 * Multi-tenant, same shape as src/librarian.ts: one sequential run per enabled
 * user from config/users.yaml, each with its own vault, job lock
 * (chiya-lint:<handle>), and shutdown wiring. One user's failure never blocks
 * the others.
 *
 * Usage: tsx src/lint.ts [--user=<handle>] [--dry-run]
 *
 * --dry-run reports every would-write (and the full report) without touching
 * the vault, log.md, or git.
 */

import { SqliteJobStore, JobRunner, PipelineCache } from 'thread-phase';

import { resolveTenantTargets, type ChiyaEnv, type TenantTarget } from './shared/env.js';
import { installShutdownHandlers } from './shared/shutdown.js';
import { VaultMutationLock, withVaultMutationLock } from './shared/vault-mutation-lock.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';
import {
  scanVault,
  resolveExternalRefs,
  regenRegistry,
  recountCitations,
  rankTopicMembers,
  regenIndex,
  exportGraph,
  reportLint,
  commitLint,
  type LintCtx,
} from './phases/lint-phases.js';

/** Reclaim RUNNING jobs whose owner has been silent this long. Heartbeats
 *  fire every 30s, so 5 minutes of silence means the process is gone. */
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

interface Args {
  user?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let user: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run' || arg === '--preview') {
      dryRun = true;
      continue;
    }
    // Both `--user=x` (librarian style) and `--user x` (scripts/ style) are
    // in use across this repo; accept either rather than making the operator
    // remember which pipeline wants which.
    const kv = /^--user=(.+)$/.exec(arg);
    if (kv) {
      user = kv[1]!;
      continue;
    }
    if (arg === '--user' && i + 1 < argv.length) {
      user = argv[++i]!;
      continue;
    }
    throw new Error(`unknown lint argument: ${arg}`);
  }
  return { user, dryRun };
}

type RunStatus = 'COMPLETED' | 'FAILED' | 'SKIPPED';

/** One full lint run against one tenant's vault. */
async function runForTenant(label: string, env: ChiyaEnv, args: Args): Promise<RunStatus> {
  const { dryRun } = args;
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const lockName = env.userHandle ? `chiya-lint:${env.userHandle}` : 'chiya-lint';
  const tag = `[lint:${label}]`;

  console.log(`${tag} vault=${env.vaultDir} db=${dbPath} mode=${dryRun ? 'dry-run' : 'apply'}`);

  const vault = new VaultFs(env.vaultDir);
  const git = new GitOps({
    vaultDir: env.vaultDir,
    remote: env.vaultRemote,
    branch: env.vaultBranch,
  });
  const jobStore = new SqliteJobStore(dbPath);
  const runner = new JobRunner(jobStore, { heartbeatMs: 30_000 });
  const vaultMutationLock = new VaultMutationLock({ vaultDir: env.vaultDir });

  const abort = new AbortController();
  const now = new Date();
  const ctx: LintCtx = {
    cache: new PipelineCache(),
    signal: abort.signal,
    dryRun,
    now,
    generatedAt: now.toISOString(),
    stats: {},
  };

  // The scan is read-only and can run outside the mutation lock; everything
  // that touches the working tree (page rewrites, log.md, the commit) runs
  // inside it so the librarian and digest never see a half-written vault.
  const mutating = [
    // First: external refs whose paper has since landed become real cites, so
    // the registry, the recount, the re-rank and the graph all see this run's
    // new edges instead of tomorrow's.
    resolveExternalRefs(vault),
    regenRegistry(vault),
    recountCitations(vault),
    rankTopicMembers(vault),
    regenIndex(vault),
    exportGraph(vault),
    reportLint(vault),
    commitLint(git, vault),
  ];
  const phases = dryRun
    ? [scanVault(vault), ...mutating]
    : [
        scanVault(vault),
        withVaultMutationLock(vaultMutationLock, mutating, 'lint-vault-mutation'),
      ];

  try {
    const reclaimed = await runner.reconcileAbandoned(STALE_HEARTBEAT_MS);
    if (reclaimed.length > 0) console.log(`${tag} reclaimed ${reclaimed.length} abandoned job(s)`);

    const jobId = await jobStore.acquireExclusive(lockName, { dryRun });
    if (!jobId) {
      console.log(`${tag} another run already in flight — skipping`);
      return 'SKIPPED';
    }
    runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) =>
      console.log(`[event:${e.eventType}]`, JSON.stringify(e.data)),
    );

    const disposeShutdown = installShutdownHandlers(`lint:${label}`, (signal) => {
      if (!abort.signal.aborted) abort.abort(`received ${signal}`);
      runner.cancel(jobId, `received ${signal}`);
    });

    try {
      await runner.run(jobId, phases, ctx, () => ({
        user: env.userHandle,
        dryRun,
        ...ctx.stats,
        wouldWrite: ctx.writes?.wouldWrite.length ?? 0,
        written: ctx.writes?.written.length ?? 0,
      }));
    } finally {
      disposeShutdown();
    }

    const final = await jobStore.getJob(jobId);
    console.log(`${tag} job ${jobId} → ${final?.status}`);
    console.log(`${tag} stats:`, ctx.stats);
    return final?.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
  } finally {
    jobStore.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targets: TenantTarget[] = resolveTenantTargets(args.user);

  let anyFailed = false;
  for (const target of targets) {
    const label = target.handle ?? 'default';
    try {
      const status = await runForTenant(label, target.env, args);
      if (status === 'FAILED') anyFailed = true;
    } catch (err) {
      // A tenant blowing up (missing vault, corrupt DB) must not block the
      // rest of the fleet.
      console.error(`[lint:${label}] fatal:`, err);
      anyFailed = true;
    }
  }
  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error('[lint] fatal:', err);
  process.exit(1);
});

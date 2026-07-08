/**
 * Librarian entry point. The librarian drains pending articles from a user's
 * ArticleStore, runs each through router → 4 parallel scouts → reviewer →
 * deterministic write, and emits source/topic/backlink pages into that
 * user's vault.
 *
 * Multi-tenant: iterates over enabled users from config/users.yaml, one
 * sequential run per user, each with its own DB, vault, git remote, job
 * lock (chiya-librarian:<handle>), and per-user soft deadline. One user's
 * failure never blocks the others. Without users.yaml it falls back to the
 * legacy single-tenant env (VAULT_DIR / CHIYA_EMAIL_TO).
 *
 * Usage: tsx src/librarian.ts [--batch=N] [--minutes=M] [--user=<handle>]
 *                             [--dry-run|--plan-only]
 *
 * Defaults: batch=10 articles, per-user soft deadline of 8 minutes. Dry-run
 * calls agents and previews apply results without mutating vault/git/rows.
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
import { sweepStaleJobLock } from './shared/sweep-stale-job.js';
import { VaultMutationLock, withVaultMutationLock } from './shared/vault-mutation-lock.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';
import {
  reapStale,
  loadBatch,
  mergeMetadata,
  commitLocal,
} from './phases/librarian-phases.js';
import { planArticleTree } from './phases/librarian-planner.js';
import { applyArticlePlans } from './phases/librarian-apply.js';
import type { LibrarianCtx } from './shared/librarian-types.js';

interface Args {
  batchSize: number;
  minutes: number;
  user?: string;
  dryRun: boolean;
  planOnly: boolean;
}

function parseArgs(): Args {
  let batchSize = 10;
  let minutes = 8;
  let user: string | undefined;
  let dryRun = false;
  let planOnly = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run' || arg === '--preview') {
      dryRun = true;
      continue;
    }
    if (arg === '--plan-only') {
      dryRun = true;
      planOnly = true;
      continue;
    }
    const kv = /^--(batch|minutes|user)=(.+)$/.exec(arg);
    if (!kv) {
      throw new Error(`unknown librarian argument: ${arg}`);
    }
    if (kv[1] === 'batch') batchSize = parseInt(kv[2]!, 10);
    if (kv[1] === 'minutes') minutes = parseInt(kv[2]!, 10);
    if (kv[1] === 'user') user = kv[2]!;
  }
  return { batchSize, minutes, user, dryRun, planOnly };
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

type RunStatus = 'COMPLETED' | 'FAILED' | 'SKIPPED';

/** One full librarian run against one tenant's env. Owns its own lock,
 *  deadline, stores, and shutdown wiring; leaks nothing across tenants. */
async function runForTenant(label: string, env: ChiyaEnv, args: Args): Promise<RunStatus> {
  const { batchSize, minutes, dryRun, planOnly } = args;
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const lockName = env.userHandle ? `chiya-librarian:${env.userHandle}` : 'chiya-librarian';
  const tag = `[librarian:${label}]`;

  console.log(
    `${tag} vault=${env.vaultDir} db=${dbPath} batch=${batchSize} minutes=${minutes} mode=${planOnly ? 'plan-only' : dryRun ? 'dry-run' : 'apply'}\n` +
      `${' '.repeat(tag.length)} tools: ${env.tools.baseUrl}/${env.tools.model}`,
  );

  const vault = new VaultFs(env.vaultDir);
  const git = new GitOps({
    vaultDir: env.vaultDir,
    remote: env.vaultRemote,
    branch: env.vaultBranch,
  });
  const store = new ArticleStore(dbPath);
  const jobStore = new SqliteJobStore(dbPath);
  const runner = new JobRunner(jobStore);
  const vaultMutationLock = new VaultMutationLock({ vaultDir: env.vaultDir });

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort('deadline-reached'),
    minutes * 60 * 1000,
  );

  const ctx: LibrarianCtx = {
    cache: new PipelineCache(),
    batchSize,
    signal: deadlineController.signal,
    dryRun,
  };

  // One inference dependency: the tools tier for router + scouts + reviewer.
  // Summaries arrive pre-computed from the shared pipeline (snippet column).
  const planningPhases = [
    ...(dryRun ? [] : [reapStale(store)]),
    loadBatch(store, { dryRun }),
    planArticleTree(
      { toolsClient: clientFor(env.tools), toolsModel: env.tools.model },
      vault,
      store,
    ),
  ];
  const phases = planOnly
    ? planningPhases
    : dryRun
      ? [...planningPhases, applyArticlePlans(vault, store, { dryRun: true })]
      : [
          ...planningPhases,
          withVaultMutationLock(
            vaultMutationLock,
            [applyArticlePlans(vault, store), mergeMetadata(vault), commitLocal(git)],
            'librarian-vault-mutation',
          ),
        ];

  try {
    // Clear orphaned lock rows from a previous crashed run (systemd hard-kills
    // well before this; anything older than 30 min is unambiguously dead).
    const swept = sweepStaleJobLock(dbPath, lockName, 30);
    if (swept > 0) console.log(`${tag} swept ${swept} stale lock row(s)`);

    const jobId = jobStore.acquireExclusive(lockName, { batchSize, minutes, dryRun, planOnly });
    if (!jobId) {
      console.log(`${tag} another run already in flight — skipping`);
      return 'SKIPPED';
    }
    runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) =>
      console.log(`[event:${e.eventType}]`, JSON.stringify(e.data)),
    );

    const disposeShutdown = installShutdownHandlers(`librarian:${label}`, (signal) => {
      if (!deadlineController.signal.aborted) deadlineController.abort(`received ${signal}`);
      runner.cancel(jobId, `received ${signal}`);
    });

    try {
      await runner.run(jobId, phases, ctx, () => ({
        user: env.userHandle,
        batchSize,
        processed: ctx.results?.length ?? ctx.articlePlans?.length ?? 0,
        dryRun,
        planOnly,
        preview: ctx.dryRunPreviews?.length ?? 0,
        counts: store.countByStatus(),
      }));
    } finally {
      disposeShutdown();
    }

    const final = jobStore.getJob(jobId);
    console.log(`${tag} job ${jobId} → ${final?.status}`);
    console.log(`${tag} table state:`, store.countByStatus());
    return final?.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
  } finally {
    clearTimeout(deadlineTimer);
    store.close();
    jobStore.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const targets: TenantTarget[] = resolveTenantTargets(args.user);

  let anyFailed = false;
  for (const target of targets) {
    const label = target.handle ?? 'default';
    try {
      const status = await runForTenant(label, target.env, args);
      if (status === 'FAILED') anyFailed = true;
    } catch (err) {
      // A tenant blowing up (bad vault path, corrupt DB) must not block the
      // rest of the fleet. Record and continue.
      console.error(`[librarian:${label}] fatal:`, err);
      anyFailed = true;
    }
  }
  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error('[librarian] fatal:', err);
  process.exit(1);
});

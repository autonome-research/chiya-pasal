/**
 * Librarian entry point. The librarian drains pending articles from the
 * ArticleStore, runs each through router → 4 parallel scouts → reviewer →
 * deterministic write, and emits source/topic/backlink pages into the vault.
 *
 * Usage: tsx src/librarian.ts [--batch=N] [--minutes=M] [--dry-run|--plan-only]
 *
 * Defaults: batch=10 articles, soft deadline of 8 minutes (matches the
 * systemd timer cadence). Dry-run mode calls agents and previews deterministic
 * apply results, but does not mutate vault files, git, or article row status.
 */

import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
} from 'thread-phase';
import OpenAI from 'openai';

import { ArticleStore } from './shared/article-store.js';
import { loadChiyaEnv, type InferenceTarget } from './shared/env.js';
import { installShutdownHandlers } from './shared/shutdown.js';
import { sweepStaleJobLock } from './shared/sweep-stale-job.js';
import { VaultMutationLock, withVaultMutationLock } from './shared/vault-mutation-lock.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';
import {
  reapStale,
  loadBatch,
  batchEnrich,
  batchExtractRefs,
  mergeMetadata,
  commitLocal,
} from './phases/librarian-phases.js';
import { planArticleTree } from './phases/librarian-planner.js';
import { applyArticlePlans } from './phases/librarian-apply.js';
import type { LibrarianCtx } from './shared/librarian-types.js';

interface Args {
  batchSize: number;
  minutes: number;
  dryRun: boolean;
  planOnly: boolean;
}

function parseArgs(): Args {
  let batchSize = 10;
  let minutes = 8;
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
    const m = /^--(batch|minutes)=(\d+)$/.exec(arg);
    if (!m) {
      throw new Error(`unknown librarian argument: ${arg}`);
    }
    if (m[1] === 'batch') batchSize = parseInt(m[2]!, 10);
    if (m[1] === 'minutes') minutes = parseInt(m[2]!, 10);
  }
  return { batchSize, minutes, dryRun, planOnly };
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

async function main(): Promise<void> {
  const { batchSize, minutes, dryRun, planOnly } = parseArgs();
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;

  console.log(
    `[librarian] vault=${env.vaultDir} db=${dbPath} batch=${batchSize} minutes=${minutes} mode=${planOnly ? 'plan-only' : dryRun ? 'dry-run' : 'apply'}\n` +
      `            tools:   ${env.tools.baseUrl}/${env.tools.model}\n` +
      `            summary: ${env.fast.baseUrl}/${env.fast.model}`,
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

  // Tools tier (gemma4:26b) for router + scouts + reviewer; fast tier
  // (gemma4:e4b) for the per-article summary call.
  const planningPhases = [
    ...(dryRun ? [] : [reapStale(store)]),
    loadBatch(store, { dryRun }),
    batchEnrich(),
    batchExtractRefs(),
    planArticleTree(
      {
        toolsClient: clientFor(env.tools),
        toolsModel: env.tools.model,
        summaryClient: clientFor(env.fast),
        summaryModel: env.fast.model,
      },
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

  // Clear orphaned lock rows from a previous crashed run (systemd hard-kills
  // at 20 min; anything older than 30 min is unambiguously dead).
  const swept = sweepStaleJobLock(dbPath, 'chiya-librarian', 30);
  if (swept > 0) console.log(`[librarian] swept ${swept} stale lock row(s)`);

  const jobId = jobStore.acquireExclusive('chiya-librarian', { batchSize, minutes, dryRun, planOnly });
  if (!jobId) {
    console.log('[librarian] another run already in flight — exiting cleanly');
    clearTimeout(deadlineTimer);
    store.close();
    jobStore.close();
    return;
  }
  runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) =>
    console.log(`[event:${e.eventType}]`, JSON.stringify(e.data)),
  );

  const disposeShutdown = installShutdownHandlers('librarian', (signal) => {
    if (!deadlineController.signal.aborted) deadlineController.abort(`received ${signal}`);
    runner.cancel(jobId, `received ${signal}`);
  });

  try {
    await runner.run(jobId, phases, ctx, () => ({
      batchSize,
      processed: ctx.results?.length ?? ctx.articlePlans?.length ?? 0,
      dryRun,
      planOnly,
      preview: ctx.dryRunPreviews?.length ?? 0,
      counts: store.countByStatus(),
    }));
  } finally {
    disposeShutdown();
    clearTimeout(deadlineTimer);
  }

  const final = jobStore.getJob(jobId);
  console.log(`[librarian] job ${jobId} → ${final?.status}`);
  console.log('[librarian] table state:', store.countByStatus());

  store.close();
  jobStore.close();
  if (final?.status === 'FAILED') process.exit(1);
}

main().catch((err) => {
  console.error('[librarian] fatal:', err);
  process.exit(1);
});

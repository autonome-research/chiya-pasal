/**
 * Librarian entry point. The librarian drains pending articles from the
 * ArticleStore, runs each through router → 4 parallel scouts → reviewer →
 * deterministic write, and emits source/topic/backlink pages into the vault.
 *
 * Usage: tsx src/librarian.ts [--batch=N] [--minutes=M]
 *
 * Defaults: batch=10 articles, soft deadline of 8 minutes (matches the
 * systemd timer cadence).
 */

import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
} from 'thread-phase';
import OpenAI from 'openai';

import { ArticleStore } from './shared/article-store.js';
import { loadChiyaEnv, type InferenceTarget } from './shared/env.js';
import { sweepStaleJobLock } from './shared/sweep-stale-job.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';
import {
  reapStale,
  loadBatch,
  batchEnrich,
  batchExtractRefs,
  perArticleTree,
  mergeMetadata,
  commitLocal,
} from './phases/librarian-phases.js';
import type { LibrarianCtx } from './shared/librarian-types.js';

interface Args {
  batchSize: number;
  minutes: number;
}

function parseArgs(): Args {
  let batchSize = 10;
  let minutes = 8;
  for (const arg of process.argv.slice(2)) {
    const m = /^--(batch|minutes)=(\d+)$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'batch') batchSize = parseInt(m[2]!, 10);
    if (m[1] === 'minutes') minutes = parseInt(m[2]!, 10);
  }
  return { batchSize, minutes };
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

async function main(): Promise<void> {
  const { batchSize, minutes } = parseArgs();
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;

  console.log(
    `[librarian] vault=${env.vaultDir} db=${dbPath} batch=${batchSize} minutes=${minutes}\n` +
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

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort('deadline-reached'),
    minutes * 60 * 1000,
  );

  const ctx: LibrarianCtx = {
    cache: new PipelineCache(),
    batchSize,
    signal: deadlineController.signal,
  };

  // Tools tier (gemma4:26b) for router + scouts + reviewer; fast tier
  // (gemma4:e4b) for the per-article summary call.
  const phases = [
    reapStale(store),
    loadBatch(store),
    batchEnrich(),
    batchExtractRefs(),
    perArticleTree(
      {
        toolsClient: clientFor(env.tools),
        toolsModel: env.tools.model,
        summaryClient: clientFor(env.fast),
        summaryModel: env.fast.model,
      },
      vault,
      store,
    ),
    mergeMetadata(vault),
    commitLocal(git),
  ];

  // Clear orphaned lock rows from a previous crashed run (systemd hard-kills
  // at 20 min; anything older than 30 min is unambiguously dead).
  const swept = sweepStaleJobLock(dbPath, 'chiya-librarian', 30);
  if (swept > 0) console.log(`[librarian] swept ${swept} stale lock row(s)`);

  const jobId = jobStore.acquireExclusive('chiya-librarian', { batchSize, minutes });
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

  try {
    await runner.run(jobId, phases, ctx, () => ({
      batchSize,
      processed: ctx.results?.length ?? 0,
      counts: store.countByStatus(),
    }));
  } finally {
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

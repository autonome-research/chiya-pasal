/**
 * Librarian pipeline entry point.
 *
 * Usage: tsx src/librarian.ts [--batch=N] [--minutes=M]
 *
 * Defaults: batch=20 articles, soft deadline of 25 minutes.
 *
 * One run drains up to `batch` pending rows from the ArticleStore. Beyond
 * the deadline, new articles aren't started — in-flight ones complete or
 * the worker rolls them back to pending. Crash recovery: stuck 'processing'
 * rows older than 60 min are flipped back to pending at the start of every
 * run.
 */

import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
} from 'thread-phase';
import OpenAI from 'openai';

import { ArticleStore } from './shared/article-store.js';
import { loadChiyaEnv, type InferenceTarget } from './shared/env.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';
import {
  commitLocal,
  loadBatch,
  mergeMetadata,
  processBatch,
  reapStale,
} from './phases/librarian-phases.js';
import type { LibrarianCtx } from './shared/librarian-types.js';

interface Args {
  batchSize: number;
  minutes: number;
}

function parseArgs(): Args {
  let batchSize = 20;
  let minutes = 25;
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
      `           triage: ${env.fast.baseUrl}/${env.fast.model}\n` +
      `           upsert: ${env.tools.baseUrl}/${env.tools.model}`,
  );

  const vault = new VaultFs(env.vaultDir);
  const git = new GitOps({ vaultDir: env.vaultDir, remote: env.vaultRemote, branch: env.vaultBranch });
  const store = new ArticleStore(dbPath);
  const jobStore = new SqliteJobStore(dbPath);
  const runner = new JobRunner(jobStore);

  // Triage runs on the fast no-tool model (mb:8005).
  // Upsert runs locally — only target with --enable-auto-tool-choice.
  const phases = [
    reapStale(store),
    loadBatch(store),
    processBatch(
      {
        triageClient: clientFor(env.fast),
        triageModel: env.fast.model,
        upsertClient: clientFor(env.tools),
        upsertModel: env.tools.model,
      },
      store,
      vault,
    ),
    mergeMetadata(vault),
    commitLocal(git),
  ];

  const ctx: LibrarianCtx = {
    cache: new PipelineCache(),
    batchSize,
    deadlineAt: new Date(Date.now() + minutes * 60 * 1000),
  };

  const jobId = runner.create('chiya-librarian', { batchSize, minutes });
  runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) =>
    console.log(`[event:${e.eventType}]`, JSON.stringify(e.data)),
  );

  await runner.run(jobId, phases, ctx, () => ({
    batchSize,
    processed: ctx.results?.length ?? 0,
    counts: store.countByStatus(),
  }));

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

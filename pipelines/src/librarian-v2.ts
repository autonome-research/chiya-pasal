/**
 * Librarian v2 entry point — parallel to src/librarian.ts. The v2 design
 * treats sources as first-class wiki pages and topics as routing nodes; see
 * src/phases/librarian-v2-phases.ts for the phase composition.
 *
 * Coexists with v1 — DOES NOT replace librarian.ts yet. Use a separate
 * THREAD_PHASE_DB and VAULT_DIR for smoke testing.
 *
 * Usage: tsx src/librarian-v2.ts [--batch=N] [--minutes=M]
 *
 * Defaults: batch=10 articles, soft deadline of 8 minutes (matches v1's
 * systemd timer cadence so the comparison is honest).
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
  reapStaleV2,
  loadBatchV2,
  batchEnrich,
  batchExtractRefs,
  perArticleTree,
  mergeMetadataV2,
  commitLocalV2,
} from './phases/librarian-v2-phases.js';
import type { LibrarianV2Ctx } from './shared/librarian-v2-types.js';

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
    `[librarian-v2] vault=${env.vaultDir} db=${dbPath} batch=${batchSize} minutes=${minutes}\n` +
      `              classify: ${env.tools.baseUrl}/${env.tools.model}\n` +
      `              summary:  ${env.fast.baseUrl}/${env.fast.model}`,
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

  const ctx: LibrarianV2Ctx = {
    cache: new PipelineCache(),
    batchSize,
    signal: deadlineController.signal,
  };

  // v3 routing: tools tier (gemma4:26b) for router + scouts + reviewer;
  // fast tier (gemma4:e4b) for the per-article summary call.
  const phases = [
    reapStaleV2(store),
    loadBatchV2(store),
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
    mergeMetadataV2(vault),
    commitLocalV2(git),
  ];

  const jobId = jobStore.acquireExclusive('chiya-librarian-v2', { batchSize, minutes });
  if (!jobId) {
    console.log('[librarian-v2] another v2 run already in flight — exiting cleanly');
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
  console.log(`[librarian-v2] job ${jobId} → ${final?.status}`);
  console.log('[librarian-v2] table state:', store.countByStatus());

  store.close();
  jobStore.close();
  if (final?.status === 'FAILED') process.exit(1);
}

main().catch((err) => {
  console.error('[librarian-v2] fatal:', err);
  process.exit(1);
});

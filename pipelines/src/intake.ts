/**
 * Intake CLI — moves new matcha articles files into the ArticleStore.
 *
 * Usage: tsx src/intake.ts
 *
 * Idempotent: dedup is enforced by ArticleStore.upsertPending (URL hash
 * unique-when-present, then title hash). Re-running on the same files
 * inserts nothing new.
 *
 * Source files are moved to vault/raw/inbox/archive/ after successful
 * intake (filesystem-level audit / re-import path).
 */

import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
} from 'thread-phase';

import { ArticleStore } from './shared/article-store.js';
import { loadChiyaEnv } from './shared/env.js';
import { installShutdownHandlers } from './shared/shutdown.js';
import { VaultFs } from './tools/vault.js';
import {
  archiveInboxFiles,
  parseAndStore,
  scanInbox,
  type IntakeCtx,
} from './phases/intake-phases.js';

async function main(): Promise<void> {
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  console.log(`[intake] vault=${env.vaultDir} db=${dbPath}`);

  const vault = new VaultFs(env.vaultDir);
  const store = new ArticleStore(dbPath);
  const jobStore = new SqliteJobStore(dbPath);
  const runner = new JobRunner(jobStore);

  const phases = [scanInbox(vault), parseAndStore(vault, store), archiveInboxFiles(vault)];

  const jobId = runner.create('chiya-intake', {});
  runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) =>
    console.log(`[event:${e.eventType}]`, JSON.stringify(e.data)),
  );

  const disposeShutdown = installShutdownHandlers('intake', (signal) => {
    runner.cancel(jobId, `received ${signal}`);
  });

  const ctx: IntakeCtx = { cache: new PipelineCache(), vaultDir: env.vaultDir };

  try {
    await runner.run(jobId, phases, ctx, () => ({
      files: ctx.fileResults?.length ?? 0,
      inserted: ctx.fileResults?.reduce((n, r) => n + r.inserted, 0) ?? 0,
      counts: store.countByStatus(),
    }));
  } finally {
    disposeShutdown();
  }

  const final = jobStore.getJob(jobId);
  console.log(`[intake] job ${jobId} → ${final?.status}`);
  console.log('[intake] table state:', store.countByStatus());

  store.close();
  jobStore.close();
  if (final?.status === 'FAILED') process.exit(1);
}

main().catch((err) => {
  console.error('[intake] fatal:', err);
  process.exit(1);
});

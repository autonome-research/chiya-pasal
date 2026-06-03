/**
 * Digest pipeline entry point.
 *
 * Usage: tsx src/digest.ts {AM|PM}
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
import { loadChiyaEnv, type InferenceTarget } from './shared/env.js';
import { installShutdownHandlers } from './shared/shutdown.js';
import { sweepStaleJobLock } from './shared/sweep-stale-job.js';
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

function parseDirection(): DigestDirection {
  const arg = process.argv[2];
  if (arg !== 'AM' && arg !== 'PM') {
    console.error('Usage: digest.ts {AM|PM}');
    process.exit(2);
  }
  return arg;
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

async function main(): Promise<void> {
  const direction = parseDirection();
  const localDate = todayLocal();
  const env = loadChiyaEnv();

  console.log(
    `[digest] direction=${direction} vault=${env.vaultDir} fast=${env.fast.baseUrl}/${env.fast.model}`,
  );

  const vault = new VaultFs(env.vaultDir);
  const git = new GitOps({ vaultDir: env.vaultDir, remote: env.vaultRemote, branch: env.vaultBranch });
  const vaultMutationLock = new VaultMutationLock({ vaultDir: env.vaultDir });
  // Digest has no tool calls — everything routes through the fast client.
  const fastClient = clientFor(env.fast);
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const articleStore = new ArticleStore(dbPath);

  const phases = [
    loadContext(vault),
    loadArticles(articleStore),
    prioritize(fastClient, env.fast.model),
    draftSections(fastClient, env.fast.model),
    assemble,
    withVaultMutationLock(
      vaultMutationLock,
      [appendLog(vault), commitDigest(git), squashAndPush(git)],
      'digest-vault-mutation',
    ),
    emailSend(env, {
      onceDaily: process.env.CHIYA_DIGEST_ONCE_DAILY === '1',
      dbPath,
    }),
  ];

  const store = new SqliteJobStore(dbPath);
  const runner = new JobRunner(store);

  const runController = new AbortController();
  const ctx: DigestCtx = {
    cache: new PipelineCache(),
    direction,
    date: localDate,
    signal: runController.signal,
  };

  // Clear orphaned lock rows from a previous crashed run (digest systemd
  // hard-kills at 15 min; anything older than 25 min is unambiguously dead).
  // Without this, a single crash mid-digest leaves the lock RUNNING forever
  // and every subsequent timer firing exits clean — the May-12 → May-17
  // five-day digest outage was exactly that scenario.
  const sweptLock = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
  if (sweptLock > 0) console.log(`[digest] swept ${sweptLock} stale lock row(s)`);

  // acquireExclusive: prevent overlapping digest runs (e.g. an AM run that
  // overruns into PM) from racing on git/email side effects.
  const jobId = store.acquireExclusive('chiya-digest', { direction, date: ctx.date });
  if (!jobId) {
    console.log('[digest] another digest run is already in flight — exiting cleanly');
    articleStore.close();
    store.close();
    return;
  }

  // Mirror events to stdout for live observation under systemd journal.
  runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) => {
    console.log(`[event:${e.eventType}]`, JSON.stringify(e.data));
  });

  const disposeShutdown = installShutdownHandlers('digest', (signal) => {
    if (!runController.signal.aborted) runController.abort(`received ${signal}`);
    runner.cancel(jobId, `received ${signal}`);
  });

  try {
    await runner.run(jobId, phases, ctx, () => ({
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

  const final = store.getJob(jobId);
  console.log(`[digest] job ${jobId} → ${final?.status}`);
  articleStore.close();
  if (final?.status === 'FAILED') {
    console.error(`[digest] error: ${final.error}`);
    store.close();
    process.exit(1);
  }
  store.close();
}

main().catch((err) => {
  console.error('[digest] fatal:', err);
  process.exit(1);
});

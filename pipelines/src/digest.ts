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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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
  const env = loadChiyaEnv();

  console.log(
    `[digest] direction=${direction} vault=${env.vaultDir} fast=${env.fast.baseUrl}/${env.fast.model}`,
  );

  const vault = new VaultFs(env.vaultDir);
  const git = new GitOps({ vaultDir: env.vaultDir, remote: env.vaultRemote, branch: env.vaultBranch });
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
    appendLog(vault),
    commitDigest(git),
    squashAndPush(git),
    emailSend(env),
  ];

  const store = new SqliteJobStore(dbPath);
  const runner = new JobRunner(store);

  const ctx: DigestCtx = {
    cache: new PipelineCache(),
    direction,
    date: todayISO(),
  };

  const jobId = runner.create('chiya-digest', { direction, date: ctx.date });

  // Mirror events to stdout for live observation under systemd journal.
  runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) => {
    console.log(`[event:${e.eventType}]`, JSON.stringify(e.data));
  });

  await runner.run(jobId, phases, ctx, () => ({
    direction: ctx.direction,
    date: ctx.date,
    articleCount: ctx.articles?.length ?? 0,
    highlighted: ctx.classified?.filter((c) => c.bucket !== 'skip').length ?? 0,
    pushed: ctx.pushed,
    emailed: ctx.emailed,
  }));

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

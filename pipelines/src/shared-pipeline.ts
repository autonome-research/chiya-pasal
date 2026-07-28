/**
 * Shared pipeline entry point — the multi-tenant layer that runs ONCE per
 * cycle regardless of user count:
 *
 *   absorb   matcha inbox files → SharedArticleStore (dedup, stable IDs)
 *   enrich   full-text ladder: arXiv HTML → direct URL → Unpaywall OA
 *   summarize one rich structured summary per article (fast tier)
 *   embed    summary embeddings (qwen3-embed via port-forward)
 *   route    cosine-match against user interests; COPY matches into each
 *            user's per-user ArticleStore; log score matrix for tuning
 *
 * No vault writes, no git, no email — those stay per-user. Missing
 * users.yaml downgrades gracefully: collection/summarization still run,
 * routing skips (so the cache warms before the first user onboards).
 *
 * Usage: tsx src/shared-pipeline.ts [--minutes=M]
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
} from 'thread-phase';
import OpenAI from 'openai';

import { loadSharedEnv, envFromUser, type InferenceTarget } from './shared/env.js';
import { SharedArticleStore } from './shared/shared-article-store.js';
import { ArticleStore } from './shared/article-store.js';
import { loadUsersConfig, listEnabledUsers, type User } from './shared/users.js';
import { installShutdownHandlers } from './shared/shutdown.js';
/** Reclaim RUNNING jobs whose owner has been silent this long. Heartbeats
 *  fire every 30s, so 5 minutes of silence means the process is gone. */
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
import type { SharedPipelineCtx } from './shared/shared-pipeline-types.js';
import { VaultFs } from './tools/vault.js';
import { scanSharedInbox, absorbInbox } from './phases/shared/absorb.js';
import { enrichPending } from './phases/shared/enrich.js';
import { summarizeEnriched } from './phases/shared/summarize.js';
import { embedSummaries, routeBroadcast, routeEmbedded } from './phases/shared/route.js';

function parseArgs(): { minutes: number } {
  let minutes = 25;
  for (const arg of process.argv.slice(2)) {
    const m = /^--minutes=(\d+)$/.exec(arg);
    if (!m) throw new Error(`unknown shared-pipeline argument: ${arg}`);
    minutes = parseInt(m[1]!, 10);
  }
  return { minutes };
}

function clientFor(target: InferenceTarget): OpenAI {
  return new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
}

function loadUsersOrEmpty(): User[] {
  try {
    return listEnabledUsers(loadUsersConfig());
  } catch (err) {
    console.warn(
      `[shared] users.yaml unavailable (${err instanceof Error ? err.message : err}) — ` +
        'collection/summarization will run; routing is skipped',
    );
    return [];
  }
}

async function main(): Promise<void> {
  const { minutes } = parseArgs();
  const env = loadSharedEnv();

  mkdirSync(env.inboxDir, { recursive: true });
  mkdirSync(join(env.dataRoot, 'shared'), { recursive: true });

  const users = loadUsersOrEmpty();
  console.log(
    `[shared] inbox=${env.inboxDir} db=${env.sharedDb} users=${users.length} minutes=${minutes} routing=${env.routingMode}\n` +
      `         summarize: ${env.fast.baseUrl}/${env.fast.model}\n` +
      (env.routingMode === 'embedding'
        ? `         embed:     ${env.embed.baseUrl}/${env.embed.model}`
        : '         embed:     (broadcast mode — embeddings not used)') +
      (env.unpaywallEmail ? '' : '\n         WARN: CHIYA_UNPAYWALL_EMAIL unset — OA enrichment rung disabled'),
  );

  const inboxFs = new VaultFs(env.inboxDir);
  const store = new SharedArticleStore(env.sharedDb);
  const jobStore = new SqliteJobStore(env.sharedDb);
  const runner = new JobRunner(jobStore, { heartbeatMs: 30_000 });

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort('deadline-reached'),
    minutes * 60 * 1000,
  );

  const ctx: SharedPipelineCtx = {
    cache: new PipelineCache(),
    signal: deadlineController.signal,
  };

  const openUserStore = (handle: string): ArticleStore => {
    const user = users.find((u) => u.handle === handle);
    if (!user) throw new Error(`route produced a match for unknown user '${handle}'`);
    const userEnv = envFromUser(user);
    mkdirSync(userEnv.vaultDir, { recursive: true });
    return new ArticleStore(join(userEnv.vaultDir, '.chiya-pipelines.db'));
  };

  const routingPhases =
    env.routingMode === 'embedding'
      ? [
          embedSummaries(store, env.embed),
          routeEmbedded(store, users, env.embed, { openUserStore }),
        ]
      : [routeBroadcast(store, users, { openUserStore })];

  const phases = [
    scanSharedInbox(inboxFs),
    absorbInbox(inboxFs, store),
    enrichPending(store, { unpaywallEmail: env.unpaywallEmail }),
    summarizeEnriched(store, { client: clientFor(env.fast), model: env.fast.model }),
    ...routingPhases,
  ];

  // Reclaim jobs whose owner stopped heartbeating (crash, hard-kill).
  const reclaimed = await runner.reconcileAbandoned(STALE_HEARTBEAT_MS);
  if (reclaimed.length > 0) console.log(`[shared] reclaimed ${reclaimed.length} abandoned job(s)`);

  const jobId = await jobStore.acquireExclusive('chiya-shared', { minutes, users: users.length });
  if (!jobId) {
    console.log('[shared] another run already in flight — exiting cleanly');
    clearTimeout(deadlineTimer);
    store.close();
    jobStore.close();
    return;
  }
  runner.on(`job:${jobId}`, (e: { eventType: string; data: unknown }) =>
    console.log(`[event:${e.eventType}]`, JSON.stringify(e.data)),
  );

  const disposeShutdown = installShutdownHandlers('shared', (signal) => {
    if (!deadlineController.signal.aborted) deadlineController.abort(`received ${signal}`);
    runner.cancel(jobId, `received ${signal}`);
  });

  try {
    await runner.run(jobId, phases, ctx, () => ({
      absorb: ctx.absorbCounts,
      enrich: ctx.enrichCounts,
      summarize: ctx.summarizeCounts,
      embedded: ctx.embeddedCount,
      route: ctx.routeCounts,
      counts: store.countByStatus(),
    }));
  } finally {
    disposeShutdown();
    clearTimeout(deadlineTimer);
  }

  const final = await jobStore.getJob(jobId);
  console.log(`[shared] job ${jobId} → ${final?.status}`);
  console.log('[shared] cache state:', store.countByStatus());

  store.close();
  jobStore.close();
  if (final?.status === 'FAILED') process.exit(1);
}

main().catch((err) => {
  console.error('[shared] fatal:', err);
  process.exit(1);
});

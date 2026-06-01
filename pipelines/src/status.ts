#!/usr/bin/env tsx
/** Lightweight operational status for articles and recent thread-phase jobs. */

import { SqliteJobStore } from 'thread-phase';
import { homedir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { ArticleStore, type ArticleStatus } from './shared/article-store.js';

interface StatusOptions {
  jobs: number;
}

interface StatusEnv {
  vaultDir: string;
  dbPath: string;
}

function parseArgs(argv = process.argv.slice(2)): StatusOptions {
  let jobs = 8;
  for (const arg of argv) {
    const m = /^--jobs=(\d+)$/.exec(arg);
    if (!m) throw new Error(`unknown status argument: ${arg}`);
    jobs = Math.max(0, Number(m[1]));
  }
  return { jobs };
}

export function statusEnv(env = process.env): StatusEnv {
  const vaultDir = resolve(env.VAULT_DIR ?? `${homedir()}/vault`);
  return {
    vaultDir,
    dbPath: env.THREAD_PHASE_DB ?? `${vaultDir}/.chiya-pipelines.db`,
  };
}

export interface StatusSnapshot {
  dbPath: string;
  articles: Record<ArticleStatus, number>;
  jobs: Array<{ id: string; name: string; status: string; createdAt: Date; completedAt: Date | null; eventCount: number }>;
}

export function loadStatus(options: StatusOptions, env = statusEnv()): StatusSnapshot {
  const store = new ArticleStore(env.dbPath);
  const jobStore = new SqliteJobStore(env.dbPath);
  try {
    const articles = store.countByStatus();
    const jobs = options.jobs > 0
      ? jobStore.listJobs({ limit: options.jobs }).map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
          eventCount: j.eventCount,
        }))
      : [];
    return { dbPath: env.dbPath, articles, jobs };
  } finally {
    store.close();
    jobStore.close();
  }
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : '-';
}

export function formatStatus(snapshot: StatusSnapshot): string {
  const a = snapshot.articles;
  const lines = [
    `db: ${snapshot.dbPath}`,
    `articles: pending=${a.pending} processing=${a.processing} done=${a.done} skipped=${a.skipped} failed=${a.failed}`,
  ];
  if (snapshot.jobs.length > 0) {
    lines.push('recent jobs:');
    for (const j of snapshot.jobs) {
      lines.push(`- ${j.createdAt.toISOString()} ${j.name} ${j.status} events=${j.eventCount} done=${fmtDate(j.completedAt)} id=${j.id}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs();
  console.log(formatStatus(loadStatus(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[status] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

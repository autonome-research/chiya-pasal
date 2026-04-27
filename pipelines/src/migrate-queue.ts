/**
 * One-shot migration: vault/raw/inbox/queue/*.md → ArticleStore.
 *
 * Pre-Option-3, the librarian processed individual queue files split out
 * by split_queue.py. Option 3 makes the article table authoritative —
 * this script imports the existing 514+ queue files into the table and
 * moves them to vault/raw/inbox/migrated/ for filesystem-level audit.
 *
 * Usage:
 *   tsx src/migrate-queue.ts --dry-run     # report only, no writes
 *   tsx src/migrate-queue.ts               # actually import + move
 *
 * Idempotent: dedup is enforced by ArticleStore. Re-running on the same
 * queue files inserts nothing (or imports any leftovers if a previous
 * run was interrupted).
 */

import { mkdir, rename, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { glob } from 'glob';

import { ArticleStore } from './shared/article-store.js';
import { parseQueueFile, pickCollectedAt } from './shared/queue-file.js';
import { loadChiyaEnv } from './shared/env.js';

interface Tally {
  scanned: number;
  parsed: number;
  inserted: number;
  duplicateUrl: number;
  duplicateTitle: number;
  parseFailed: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const queueDir = join(env.vaultDir, 'raw', 'inbox', 'queue');
  const migratedDir = join(env.vaultDir, 'raw', 'inbox', 'migrated');

  console.log(`[migrate] vault=${env.vaultDir}`);
  console.log(`[migrate] queue=${queueDir}`);
  console.log(`[migrate] mode=${dryRun ? 'DRY-RUN' : 'WRITE'}`);

  const files = (await glob('*.md', { cwd: queueDir, absolute: true })).sort();
  console.log(`[migrate] found ${files.length} queue file(s)`);

  if (files.length === 0) {
    console.log('[migrate] nothing to do.');
    return;
  }

  const store = new ArticleStore(dbPath);
  const tally: Tally = {
    scanned: 0,
    parsed: 0,
    inserted: 0,
    duplicateUrl: 0,
    duplicateTitle: 0,
    parseFailed: 0,
  };

  if (!dryRun) await mkdir(migratedDir, { recursive: true });

  for (const file of files) {
    tally.scanned++;
    const stats = await stat(file);
    const text = await readFile(file, 'utf8');
    const article = parseQueueFile(text);
    if (!article) {
      tally.parseFailed++;
      console.warn(`[migrate] parse-failed: ${file}`);
      continue;
    }
    tally.parsed++;

    if (dryRun) {
      // Just count what would happen.
      continue;
    }

    const r = store.upsertPending({
      title: article.title,
      url: article.url,
      source: article.source,
      field: article.field,
      snippet: article.snippet,
      collectedFrom: `raw/inbox/queue/${file.split('/').pop()}`,
      collectedAt: pickCollectedAt(stats),
    });
    if (r.result === 'inserted') tally.inserted++;
    else if (r.result === 'duplicate-url') tally.duplicateUrl++;
    else tally.duplicateTitle++;

    // Move regardless of dedup outcome — file is fully accounted for.
    const dst = join(migratedDir, file.split('/').pop()!);
    await rename(file, dst);

    if (tally.scanned % 50 === 0) {
      console.log(
        `[migrate] progress ${tally.scanned}/${files.length} — ${tally.inserted} new`,
      );
    }
  }

  console.log('[migrate] tally:', tally);
  console.log('[migrate] table state:', store.countByStatus());
  store.close();
}

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});

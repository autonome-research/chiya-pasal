#!/usr/bin/env tsx
/**
 * Backfill ArticleStore from archived raw inbox Markdown files.
 *
 * Use when the SQLite ArticleStore has been lost/reset but the vault still has
 * raw/inbox/archive/YYYY-MM-DD-articles.md audit files. This restores dedup
 * memory and, when requested, can re-queue archived articles for graph curation
 * using their original collection date instead of today's date.
 */

import { homedir } from 'os';
import { join, basename } from 'path';
import { readFile } from 'fs/promises';
import { glob } from 'glob';

import { parseArticles } from '../src/shared/article.js';
import { ArticleStore, type ArticleStatus } from '../src/shared/article-store.js';

interface Args {
  vaultDir: string;
  dbPath: string;
  status: Extract<ArticleStatus, 'pending' | 'done'>;
  includeActive: boolean;
  markExistingDone: boolean;
}

function parseArgs(): Args {
  const vaultDir = process.env.VAULT_DIR ?? join(homedir(), 'vault');
  const args: Args = {
    vaultDir,
    dbPath: process.env.THREAD_PHASE_DB ?? join(vaultDir, '.chiya-pipelines.db'),
    status: 'done',
    includeActive: false,
    markExistingDone: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--include-active') args.includeActive = true;
    else if (arg === '--mark-existing-done') args.markExistingDone = true;
    else if (arg === '--status=pending') args.status = 'pending';
    else if (arg === '--status=done') args.status = 'done';
    else if (arg.startsWith('--vault=')) args.vaultDir = arg.slice('--vault='.length);
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  return args;
}

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error(`Usage: tsx scripts/backfill-archive-articles.ts [options]

Options:
  --status=done|pending     Insert restored rows as done or pending (default: done)
  --include-active          Also read raw/inbox/*-articles.md, not just archive/
  --mark-existing-done      If a duplicate row already exists, mark it done
  --vault=/path/to/vault    Override VAULT_DIR
  --db=/path/to/db          Override THREAD_PHASE_DB
`);
  process.exit(code);
}

function dateFromFilename(path: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})-articles\.md$/.exec(basename(path));
  if (!m) return null;
  // Local noon avoids edge cases around local midnight/DST while preserving the
  // intended local collection day for digest/listByLocalDate queries.
  return new Date(`${m[1]}T12:00:00`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const patterns = [join(args.vaultDir, 'raw', 'inbox', 'archive', '*-articles.md')];
  if (args.includeActive) patterns.push(join(args.vaultDir, 'raw', 'inbox', '*-articles.md'));

  const files = (await glob(patterns, { nodir: true })).sort();
  const store = new ArticleStore(args.dbPath);
  const totals = { files: 0, parsed: 0, inserted: 0, duplicateUrl: 0, duplicateTitle: 0, markedDone: 0 };

  try {
    for (const file of files) {
      const collectedAt = dateFromFilename(file);
      if (!collectedAt) continue;
      const vaultRel = file.startsWith(args.vaultDir + '/') ? file.slice(args.vaultDir.length + 1) : file;
      const articles = parseArticles(await readFile(file, 'utf8'));
      totals.files++;
      totals.parsed += articles.length;

      for (const article of articles) {
        const result = store.upsertPending({
          title: article.title,
          url: article.url || null,
          source: article.source,
          field: article.field,
          snippet: article.snippet,
          collectedFrom: vaultRel,
          collectedAt,
        });

        if (result.result === 'inserted') {
          totals.inserted++;
          if (args.status === 'done' && result.id !== null) {
            store.markDone(result.id, []);
            totals.markedDone++;
          }
        } else if (result.result === 'duplicate-url') {
          totals.duplicateUrl++;
          if (args.markExistingDone && result.id !== null) {
            store.markDone(result.id, []);
            totals.markedDone++;
          }
        } else {
          totals.duplicateTitle++;
          if (args.markExistingDone && result.id !== null) {
            store.markDone(result.id, []);
            totals.markedDone++;
          }
        }
      }
    }
  } finally {
    store.close();
  }

  console.log(JSON.stringify({ ...totals, status: args.status, dbPath: args.dbPath }, null, 2));
}

main().catch((err) => {
  console.error('[backfill-archive-articles] fatal:', err);
  process.exit(1);
});

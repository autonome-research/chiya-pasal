#!/usr/bin/env tsx
/**
 * Repair source pages poisoned by the legacy May–June error-blob injection:
 * pages whose `## Summary` section is a raw `{"_error":true,...}` JSON blob
 * written verbatim by a since-sealed upstream failure path. All affected
 * article rows sit at status='done', and the librarian-planner early-returns
 * 'already-ingested' for any article whose wiki/sources/<id>.md exists — so
 * repair MUST delete the poisoned page file, not just reset the row.
 *
 * Partition per poisoned page:
 *   recoverable   — row exists with a usable prose snippet (>80 chars):
 *                   reset row to 'pending' (page_paths cleared) + delete the
 *                   page, so the librarian regenerates it through the normal
 *                   quality path.
 *   unrecoverable — row exists but snippet is empty/missing: append the
 *                   article to the re-ingest file (shared-inbox markdown,
 *                   `- [Title](url) *(source)*`), delete the row (frees its
 *                   dedup hashes), delete the page. Drop the re-ingest file
 *                   into the shared inbox for full re-ingestion.
 *   orphan        — page with no matching row: reported, never touched.
 *
 * Modes:
 *   default    — DRY-RUN: full report (counts per cohort + samples), no writes.
 *   --execute  — perform the repair. Idempotent: repaired pages are gone on
 *                re-run, and re-ingest lines dedup by URL against the
 *                existing output file.
 *
 * Flags:
 *   --user <handle>   required (any user in users.yaml, paused included)
 *   --execute         apply; default is dry-run
 *   --db <path>       override db path (default <vault>/.chiya-pipelines.db)
 *   --out <path>      override re-ingest file (default ./<date>-repair-articles.md —
 *                     the '-articles.md' suffix is what the shared inbox scan
 *                     globs for, so the file works as a drop-in)
 *
 * The final stdout line is a JSON summary (machine-readable; tests parse it).
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { basename, join, resolve } from 'path';

import { ArticleStore, type ArticleRow } from '../src/shared/article-store.js';
import { envFromUser } from '../src/shared/env.js';
import { loadUsersConfig } from '../src/shared/users.js';

interface Args {
  user: string;
  execute: boolean;
  dbOverride: string | null;
  outOverride: string | null;
}

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error(`Usage: tsx scripts/repair-error-summaries.ts --user <handle> [options]

Options:
  --execute       Apply the repair (default: dry-run, prints report only)
  --db <path>     Override the ArticleStore db path
  --out <path>    Override the re-ingest output file
`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  let user: string | null = null;
  let execute = false;
  let dbOverride: string | null = null;
  let outOverride: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg.startsWith('--') ? arg.slice(2).split('=')[0]! : null;
    const value = (): string => {
      const eq = arg.indexOf('=');
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) usage(2, `--${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case 'user':
        user = value();
        break;
      case 'db':
        dbOverride = value();
        break;
      case 'out':
        outOverride = value();
        break;
      case 'execute':
        execute = true;
        break;
      case 'help':
        usage(0);
        break;
      default:
        usage(2, `unknown argument: ${arg}`);
    }
  }
  if (!user) usage(2, '--user is required');
  return { user, execute, dbOverride, outOverride };
}

// The blob is the first non-blank content after the ## Summary heading.
const SUMMARY_ERROR_RE = /^##\s+Summary\s*\n+\s*\{\s*"_error"\s*:\s*true/m;

function frontmatterUrl(text: string): string | null {
  const m = /^url:\s*(\S+)\s*$/m.exec(text);
  return m ? m[1]! : null;
}

/** A snippet the librarian can actually work from: real prose, not a blob. */
function usableSnippet(snippet: string | null): boolean {
  const s = (snippet ?? '').trim();
  return s.length > 80 && !/^\{\s*"_error"/.test(s);
}

interface PoisonedPage {
  /** vault-relative, e.g. wiki/sources/arxiv-2605-11111.md */
  relPath: string;
  absPath: string;
  row: ArticleRow | null;
}

function findRow(store: ArticleStore, relPath: string, pageUrl: string | null): ArticleRow | null {
  // URL join first: source pages are 1:1 with normalized URLs, and it still
  // matches after a crashed prior run cleared the row's page_paths.
  if (pageUrl) {
    const byUrl = store.findByUrl(pageUrl);
    if (byUrl) return byUrl;
  }
  // Fallback: page_paths join ('done' rows). A topic-sharing row can't false-
  // positive here because page_paths matches the exact quoted source path.
  const candidates = store.findByPagePath(relPath);
  return candidates[0] ?? null;
}

function reingestLine(row: ArticleRow): string {
  const source = row.source ? ` *(${row.source})*` : '';
  return `- [${row.title}](${row.url})${source}`;
}

function appendReingest(outPath: string, rows: ArticleRow[]): number {
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null;
  const fresh = rows.filter((r) => !existing?.includes(`](${r.url})`));
  if (fresh.length === 0) return 0;

  let block = '';
  if (existing === null) {
    block +=
      `# Repair re-ingest — ${new Date().toISOString().slice(0, 10)}\n\n` +
      `> Articles whose poisoned source pages had no locally recoverable abstract.\n` +
      `> Drop this file into the shared inbox for full re-ingestion.\n`;
  }
  // Group by field so absorb's field headings survive the round trip.
  const byField = new Map<string, ArticleRow[]>();
  for (const r of fresh) {
    const field = r.field ?? 'Uncategorized';
    byField.set(field, [...(byField.get(field) ?? []), r]);
  }
  for (const [field, group] of byField) {
    block += `\n#### ${field}\n`;
    for (const r of group) block += `${reingestLine(r)}\n`;
  }
  appendFileSync(outPath, block, 'utf-8');
  return fresh.length;
}

function sample(pages: PoisonedPage[], n: number = 5): string[] {
  return pages.slice(0, n).map((p) => p.relPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = loadUsersConfig();
  // Paused users included deliberately — repair is exactly the kind of task
  // that happens while a tenant is paused.
  const user = config.users.find((u) => u.handle === args.user);
  if (!user) {
    console.error(`error: no user with handle '${args.user}'`);
    process.exit(1);
  }
  const vaultDir = envFromUser(user).vaultDir;
  const dbPath = args.dbOverride ?? join(vaultDir, '.chiya-pipelines.db');
  if (!existsSync(dbPath)) {
    console.error(`error: no ArticleStore db at ${dbPath}`);
    process.exit(1);
  }
  const outPath = resolve(
    // Must match the shared inbox scan glob ('*-articles.md') so the file can
    // be dropped in verbatim.
    args.outOverride ?? join(process.cwd(), `${new Date().toISOString().slice(0, 10)}-repair-articles.md`),
  );

  const mode = args.execute ? 'EXECUTE' : 'dry-run';
  console.log(`[repair] user=${args.user} vault=${vaultDir} db=${dbPath} mode=${mode}`);

  const sourcesDir = join(vaultDir, 'wiki', 'sources');
  const files = existsSync(sourcesDir)
    ? readdirSync(sourcesDir).filter((f) => f.endsWith('.md')).sort()
    : [];

  const store = new ArticleStore(dbPath);
  const recoverable: PoisonedPage[] = [];
  const unrecoverable: PoisonedPage[] = [];
  const orphans: PoisonedPage[] = [];
  const noUrl: PoisonedPage[] = [];

  try {
    for (const file of files) {
      const absPath = join(sourcesDir, file);
      const text = readFileSync(absPath, 'utf-8');
      if (!SUMMARY_ERROR_RE.test(text)) continue;

      const relPath = `wiki/sources/${basename(file)}`;
      const row = findRow(store, relPath, frontmatterUrl(text));
      const page: PoisonedPage = { relPath, absPath, row };

      if (!row) orphans.push(page);
      else if (usableSnippet(row.snippet)) recoverable.push(page);
      else if (!row.url) noUrl.push(page); // can't emit a re-ingest link; leave for the operator
      else unrecoverable.push(page);
    }

    const poisoned = recoverable.length + unrecoverable.length + orphans.length + noUrl.length;
    console.log(`[repair] scanned ${files.length} source page(s); ${poisoned} poisoned`);
    console.log(`[repair]   recoverable (snippet survives, requeue locally): ${recoverable.length}`);
    for (const s of sample(recoverable)) console.log(`[repair]     e.g. ${s}`);
    console.log(`[repair]   unrecoverable (no snippet, emit re-ingest line): ${unrecoverable.length}`);
    for (const s of sample(unrecoverable)) console.log(`[repair]     e.g. ${s}`);
    console.log(`[repair]   orphans (no matching row, report only): ${orphans.length}`);
    for (const s of sample(orphans)) console.log(`[repair]     e.g. ${s}`);
    if (noUrl.length > 0) {
      console.log(`[repair]   row-without-url (left untouched, fix manually): ${noUrl.length}`);
      for (const s of sample(noUrl)) console.log(`[repair]     e.g. ${s}`);
    }

    let requeued = 0;
    let deletedRows = 0;
    let deletedPages = 0;
    let reingestLines = 0;

    if (args.execute) {
      for (const page of recoverable) {
        // Row first, file second: if we crash between, the URL join still
        // finds the (now pending) row on re-run and the delete completes.
        store.resetToPending(page.row!.id);
        requeued++;
        rmSync(page.absPath);
        deletedPages++;
      }

      // Re-ingest lines land before any row/file deletion so a crash can
      // never lose an article: worst case is a leftover orphan page, which
      // every subsequent run reports.
      reingestLines = appendReingest(outPath, unrecoverable.map((p) => p.row!));
      for (const page of unrecoverable) {
        store.deleteById(page.row!.id);
        deletedRows++;
        rmSync(page.absPath);
        deletedPages++;
      }

      if (reingestLines > 0) {
        console.log(`[repair] appended ${reingestLines} re-ingest line(s) to ${outPath}`);
      }
      console.log(
        `[repair] done: requeued ${requeued} row(s), deleted ${deletedRows} row(s), removed ${deletedPages} page file(s)`,
      );
    } else {
      console.log('[repair] dry run — nothing touched. Re-run with --execute to repair.');
    }

    console.log(
      JSON.stringify({
        mode,
        scanned: files.length,
        poisoned,
        recoverable: recoverable.length,
        unrecoverable: unrecoverable.length,
        orphans: orphans.length,
        rowWithoutUrl: noUrl.length,
        requeued,
        deletedRows,
        deletedPages,
        reingestLines,
        reingestFile: outPath,
      }),
    );
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error('[repair] fatal:', err);
  process.exit(1);
});

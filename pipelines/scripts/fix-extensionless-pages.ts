#!/usr/bin/env tsx
/**
 * Give extensionless wiki pages their `.md` back.
 *
 * An early writer bug dropped the extension on some pages. A file without
 * `.md` is invisible to every scout glob, to the lint scan, to the registry,
 * and to Obsidian itself — the content is on disk and in git, but nothing in
 * the system can see it. ~424 pages are in that state.
 *
 * Two situations, two dispositions:
 *
 *   1. No `.md` twin  → rename `<name>` to `<name>.md`. Pure recovery: the
 *      file becomes visible, nothing else changes.
 *   2. A `.md` twin exists → split brain. Identical content means the twin is
 *      already the live page and the extensionless file is a leftover, so it
 *      is deleted. DIFFERING content is reported and nothing is touched:
 *      merging two divergent versions of a page is a judgment call, and this
 *      script does not make judgment calls.
 *
 * Twin lookup is canonical-slug-aware. For a page under `wiki/topics/`, the
 * canonical location is the FLAT `wiki/topics/<slug>.md` (topics are a flat
 * namespace — see AGENTS.md), so a nested `wiki/topics/ai-ml/<slug>` counts
 * as twinned when `wiki/topics/<slug>.md` exists even though there is nothing
 * beside it in its own directory. That is where the split-brain pages are:
 * 106 of them. Without this rule they'd look untwinned and get renamed into a
 * second, nested copy of a page that already exists flat.
 *
 * What this script deliberately does NOT do:
 *   - flatten nested topic pages (that is `migrate-topics.ts`, which also
 *     lifts directory names into `clusters:` and rewrites wikilinks)
 *   - merge divergent twins
 *   - touch git. Renames and deletions land in the working tree as ordinary
 *     changes; the next pipeline commit picks them up.
 *
 * Usage:
 *   tsx scripts/fix-extensionless-pages.ts --user <handle>            # dry run
 *   tsx scripts/fix-extensionless-pages.ts --user <handle> --execute  # write
 *
 * Dry run is the default. Either mode ends with a one-line JSON summary.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join, relative, sep } from 'path';

import { loadChiyaEnvFor } from '../src/shared/env.js';

// ---- scanning -------------------------------------------------------------

/**
 * Every extensionless regular file under `wikiDir`, recursively, sorted.
 *
 * "Extensionless" means the basename contains no `.` at all. A name like
 * `arxiv-2605.03823` is left alone on purpose: its trailing segment is part
 * of the identifier, not a wrong extension, and guessing otherwise risks
 * mangling names. Dotfiles (`.gitkeep`) and dot-directories are skipped.
 */
export function findExtensionlessFiles(wikiDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(wikiDir)) return out;

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets, fifos: not our business
      if (entry.name.includes('.')) continue;
      out.push(full);
    }
  };

  walk(wikiDir);
  return out;
}

// ---- planning -------------------------------------------------------------

export type FixOutcome = 'rename' | 'delete-duplicate' | 'conflict';

export interface FixPlan {
  /** Absolute path of the extensionless file. */
  path: string;
  /** Vault-relative path, for reporting. */
  relPath: string;
  outcome: FixOutcome;
  /** Absolute path this file is renamed to ('rename' only). */
  target?: string;
  /** Absolute path of the `.md` twin ('delete-duplicate' | 'conflict'). */
  twin?: string;
  /** Vault-relative twin path, for reporting. */
  relTwin?: string;
  /** True when the rename lands inside a `wiki/topics/` subdirectory, which
   *  every scanner ignores — visible to Obsidian, still invisible to the
   *  registry until the operator flattens it. */
  nestedTopic?: boolean;
}

/**
 * Candidate `.md` twins for an extensionless file, most-specific first:
 * the sibling `<name>.md`, then — for topic pages only — the canonical flat
 * `wiki/topics/<slug>.md`.
 */
export function twinCandidates(vaultDir: string, path: string): string[] {
  const candidates = [`${path}.md`];
  const topicsDir = join(vaultDir, 'wiki', 'topics');
  if (isUnder(topicsDir, path) && dirname(path) !== topicsDir) {
    candidates.push(join(topicsDir, `${basename(path)}.md`));
  }
  return candidates;
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(sep);
}

function sameBytes(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Classify every extensionless page under `<vaultDir>/wiki`. Read-only:
 * planning never writes, so the dry run and the execute run see the same
 * plan and `--execute` is exactly "apply what you were just shown".
 */
export function planFixes(vaultDir: string): FixPlan[] {
  const wikiDir = join(vaultDir, 'wiki');
  const topicsDir = join(wikiDir, 'topics');
  const plans: FixPlan[] = [];

  for (const path of findExtensionlessFiles(wikiDir)) {
    const relPath = relative(vaultDir, path);
    const twin = twinCandidates(vaultDir, path).find((c) => existsSync(c));

    if (!twin) {
      plans.push({
        path,
        relPath,
        outcome: 'rename',
        target: `${path}.md`,
        nestedTopic: isUnder(topicsDir, path) && dirname(path) !== topicsDir,
      });
      continue;
    }

    plans.push({
      path,
      relPath,
      outcome: sameBytes(path, twin) ? 'delete-duplicate' : 'conflict',
      twin,
      relTwin: relative(vaultDir, twin),
    });
  }

  return plans;
}

// ---- applying -------------------------------------------------------------

export interface ApplyResult {
  renamed: number;
  deleted: number;
  /** Plans skipped because the disk changed under us since planning. */
  skipped: number;
}

/**
 * Execute a plan. 'conflict' entries are never acted on — they are the
 * operator's call. Every step re-checks disk state first, so applying a stale
 * plan degrades to a skip rather than clobbering a file.
 */
export function applyFixes(plans: FixPlan[]): ApplyResult {
  const result: ApplyResult = { renamed: 0, deleted: 0, skipped: 0 };

  for (const plan of plans) {
    if (plan.outcome === 'conflict') continue;
    if (!existsSync(plan.path) || !statSync(plan.path).isFile()) {
      result.skipped++;
      continue;
    }

    if (plan.outcome === 'rename') {
      const target = plan.target!;
      // A twin appearing between plan and apply turns a rename into a
      // potential overwrite. Refuse; the next run will re-plan it as a
      // delete-duplicate or a conflict.
      if (existsSync(target)) {
        result.skipped++;
        continue;
      }
      renameSync(plan.path, target);
      result.renamed++;
      continue;
    }

    // delete-duplicate: re-verify the twin is still byte-identical, so a
    // twin edited since planning is preserved rather than silently deduped.
    const twin = plan.twin!;
    if (!existsSync(twin) || !sameBytes(plan.path, twin)) {
      result.skipped++;
      continue;
    }
    unlinkSync(plan.path);
    result.deleted++;
  }

  return result;
}

// ---- CLI ------------------------------------------------------------------

interface Args {
  user: string;
  execute: boolean;
}

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error(`Usage: tsx scripts/fix-extensionless-pages.ts --user <handle> [--execute]

Options:
  --user <handle>   Tenant whose vault to fix (required)
  --execute         Rename/delete for real (default: dry run)
`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  let user: string | null = null;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--execute') execute = true;
    else if (arg === '--user') user = argv[++i] ?? null;
    else if (arg.startsWith('--user=')) user = arg.slice('--user='.length);
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (!user) usage(2, '--user <handle> is required');
  return { user, execute };
}

const SAMPLE_SIZE = 10;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const env = loadChiyaEnvFor(args.user);

  console.log(
    `[fix-extensionless-pages] user=${args.user} vault=${env.vaultDir} ` +
      `mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'}`,
  );

  const plans = planFixes(env.vaultDir);
  const by = (o: FixOutcome): FixPlan[] => plans.filter((p) => p.outcome === o);
  const renames = by('rename');
  const duplicates = by('delete-duplicate');
  const conflicts = by('conflict');
  const nestedTopicRenames = renames.filter((p) => p.nestedTopic).length;

  console.log(
    `[fix-extensionless-pages] extensionless=${plans.length} rename=${renames.length} ` +
      `delete-duplicate=${duplicates.length} conflict=${conflicts.length}`,
  );

  for (const p of renames.slice(0, SAMPLE_SIZE)) console.log(`  rename ${p.relPath} → ${p.relPath}.md`);
  for (const p of duplicates.slice(0, SAMPLE_SIZE)) {
    console.log(`  delete ${p.relPath} (identical to ${p.relTwin})`);
  }
  for (const p of conflicts) console.log(`  CONFLICT ${p.relPath} differs from ${p.relTwin}`);

  if (nestedTopicRenames > 0) {
    console.log(
      `[fix-extensionless-pages] note: ${nestedTopicRenames} rename(s) land inside a ` +
        `wiki/topics/ subdirectory — visible to Obsidian, still ignored by the ` +
        `registry/index/graph scans until they are flattened (scripts/migrate-topics.ts).`,
    );
  }

  let applied: ApplyResult = { renamed: 0, deleted: 0, skipped: 0 };
  if (args.execute) {
    applied = applyFixes(plans);
    console.log(
      `[fix-extensionless-pages] renamed=${applied.renamed} deleted=${applied.deleted} ` +
        `skipped=${applied.skipped}; git left untouched.`,
    );
  } else {
    console.log('[fix-extensionless-pages] dry run — no files touched. Re-run with --execute.');
  }

  console.log(
    JSON.stringify({
      script: 'fix-extensionless-pages',
      user: args.user,
      vaultDir: env.vaultDir,
      mode: args.execute ? 'execute' : 'dry-run',
      extensionless: plans.length,
      planned: {
        rename: renames.length,
        deleteDuplicate: duplicates.length,
        conflict: conflicts.length,
        nestedTopicRenames,
      },
      applied,
      // Sample only — every conflict is printed in full above; keeping the
      // whole list here would make the summary line unreadable at 121 of them.
      conflictSample: conflicts
        .slice(0, SAMPLE_SIZE)
        .map((p) => ({ path: p.relPath, twin: p.relTwin })),
    }),
  );
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('fix-extensionless-pages.ts') ||
  process.argv[1]?.endsWith('fix-extensionless-pages.js');

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[fix-extensionless-pages] fatal:', err);
    process.exit(1);
  }
}

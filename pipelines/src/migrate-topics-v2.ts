/**
 * One-shot migration: legacy synthesis-encyclopedia topic pages → catalog
 * routing nodes.
 *
 * The old topic page was a long synthesis paragraph with a `## Sources` list.
 * The new topic page is a routing node:
 *   - stable definition paragraph
 *   - `## Member sources` (auto-maintained by the librarian)
 *   - optional `## Related topics`
 *
 * This script also flattens the field-based directory hierarchy
 * (`wiki/topics/<field>/foo.md` → `wiki/topics/foo.md`) and rewrites every
 * wikilink across the vault that points at an old path.
 *
 * Flow per page:
 *   1. Parse existing content; extract definition (first paragraph after H1
 *      and before any `## ` heading).
 *   2. Compute the new flat path (basename without `.md` is the slug).
 *   3. Detect collisions; resolve by (a) larger member count wins,
 *      (b) lexicographic oldPath as tiebreaker. Losers are not migrated.
 *   4. Look up contributing articles via ArticleStore.findByPagePath.
 *      Each becomes a member entry keyed by stable-id filename.
 *   5. Render with formatTopicPage.
 *
 * Modes:
 *   - default (no flags): dry-run. Prints the plan; does not write.
 *   - --apply: moves files (git mv), writes new content, runs the wikilink
 *     rewriter across wiki/, creates a single git commit.
 *
 * The wikilink rewriter (./shared/wikilink-rewriter.js) must be present at
 * apply-time. Pure-function tests in __tests__ do not import it.
 */

import { spawn } from 'child_process';
import { posix } from 'path';

import { ArticleStore, type ArticleRow } from './shared/article-store.js';
import { loadChiyaEnv } from './shared/env.js';
import {
  formatTopicPage,
  stableIdForUrl,
  stableIdToFilename,
  type TopicPageInput,
} from './phases/page-templates.js';
import { rewriteWikilinks, type RenameMap } from './shared/wikilink-rewriter.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';

// ---- pure-function helpers (exported for tests) ---------------------------

/**
 * First non-empty paragraph after the H1 and before any `## ` heading.
 * Frontmatter (between `---` markers) is skipped before scanning.
 * Returns '' if no definition paragraph can be extracted.
 *
 * Wikilinks/inline markdown in the paragraph are preserved verbatim — we
 * don't reformat the text, just lift it out.
 */
export function extractDefinition(pageText: string): string {
  let body = pageText;

  if (body.startsWith('---\n')) {
    const closeIdx = body.indexOf('\n---', 4);
    if (closeIdx >= 0) {
      body = body.slice(closeIdx + 4);
      if (body.startsWith('\n')) body = body.slice(1);
    }
  }

  const lines = body.split('\n');
  let i = 0;

  // Skip leading blank lines.
  while (i < lines.length && lines[i]!.trim() === '') i++;

  // Optional H1; the legacy pages always have one but we tolerate missing.
  if (i < lines.length && lines[i]!.startsWith('# ') && !lines[i]!.startsWith('## ')) {
    i++;
  }

  // Collect the first non-empty paragraph that doesn't start at a `## ` heading.
  // Stops at the next blank line or the next `## ` heading.
  while (i < lines.length && lines[i]!.trim() === '') i++;

  const buf: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('## ')) break;
    if (line.trim() === '') {
      if (buf.length > 0) break;
      i++;
      continue;
    }
    buf.push(line);
    i++;
  }

  return buf.join('\n').trim();
}

/**
 * Collapse any subdirectory under `wiki/topics/` so the slug filename ends up
 * directly under `wiki/topics/`. Deepest basename wins for further-nested
 * paths. Paths outside `wiki/topics/` are returned unchanged.
 */
export function flattenTopicPath(oldPath: string): string {
  const normalized = oldPath.replace(/\\/g, '/');
  const prefix = 'wiki/topics/';
  if (!normalized.startsWith(prefix)) return oldPath;
  const base = posix.basename(normalized);
  return `${prefix}${base}`;
}

export function topicSlugFromPath(path: string): string {
  const base = posix.basename(path.replace(/\\/g, '/'));
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

interface CollisionInput {
  oldPath: string;
  newPath: string;
  memberCount: number;
}

interface CollisionResult {
  resolved: Array<{ oldPath: string; newPath: string }>;
  conflicts: Array<{
    newPath: string;
    candidates: Array<{ oldPath: string; memberCount: number }>;
    chosen: string;
  }>;
}

/**
 * Group plans by newPath. Where multiple oldPaths collapse to the same target,
 * resolve by (1) larger memberCount, (2) lexicographic oldPath as tiebreaker.
 * Only the winner appears in `resolved`; losers appear only in `conflicts`.
 */
export function planCollisions(plans: CollisionInput[]): CollisionResult {
  const byNew = new Map<string, CollisionInput[]>();
  for (const p of plans) {
    const arr = byNew.get(p.newPath) ?? [];
    arr.push(p);
    byNew.set(p.newPath, arr);
  }

  const resolved: Array<{ oldPath: string; newPath: string }> = [];
  const conflicts: CollisionResult['conflicts'] = [];

  // Iterate in a deterministic order so output is stable across runs.
  const newPaths = [...byNew.keys()].sort();
  for (const newPath of newPaths) {
    const candidates = byNew.get(newPath)!;
    if (candidates.length === 1) {
      resolved.push({ oldPath: candidates[0]!.oldPath, newPath });
      continue;
    }
    const ranked = [...candidates].sort((a, b) => {
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      return a.oldPath < b.oldPath ? -1 : a.oldPath > b.oldPath ? 1 : 0;
    });
    const chosen = ranked[0]!.oldPath;
    resolved.push({ oldPath: chosen, newPath });
    conflicts.push({
      newPath,
      candidates: candidates.map((c) => ({ oldPath: c.oldPath, memberCount: c.memberCount })),
      chosen,
    });
  }

  return { resolved, conflicts };
}

// ---- frontmatter helpers --------------------------------------------------

/**
 * Pull a single scalar field from YAML frontmatter without parsing the whole
 * doc. Good enough for the loose schema we have — `key: value` on one line.
 */
function readFrontmatterScalar(text: string, key: string): string | null {
  if (!text.startsWith('---\n')) return null;
  const closeIdx = text.indexOf('\n---', 4);
  if (closeIdx < 0) return null;
  const fm = text.slice(4, closeIdx);
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
  const m = re.exec(fm);
  return m ? m[1]! : null;
}

function parseYmd(s: string | null): Date | null {
  if (!s) return null;
  // Tolerate quoted values like "2026-05-06".
  const trimmed = s.replace(/^["']|["']$/g, '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ---- planning + apply -----------------------------------------------------

interface PagePlan {
  oldPath: string;
  newPath: string;
  slug: string;
  definition: string;
  definitionStatus: 'extracted' | 'empty';
  members: Array<{ filename: string; title: string; collected: Date }>;
  memberCount: number;
  skippedNoUrl: number;
  created: Date;
  newContent: string;
}

function buildPlan(
  oldPath: string,
  text: string,
  articles: ArticleRow[],
  today: Date,
): PagePlan {
  const newPath = flattenTopicPath(oldPath);
  const slug = topicSlugFromPath(newPath);

  const definition = extractDefinition(text);
  const definitionStatus = definition.length > 0 ? 'extracted' : 'empty';

  const members: PagePlan['members'] = [];
  let skippedNoUrl = 0;
  for (const a of articles) {
    if (!a.url) {
      skippedNoUrl++;
      continue;
    }
    const id = stableIdForUrl(a.url);
    if (!id) {
      skippedNoUrl++;
      continue;
    }
    members.push({
      filename: stableIdToFilename(id),
      title: a.title,
      collected: a.collectedAt,
    });
  }

  const createdFromFm = parseYmd(readFrontmatterScalar(text, 'updated'));
  const created = createdFromFm ?? today;

  const input: TopicPageInput = {
    slug,
    created,
    updated: today,
    definition,
    members,
    relatedTopics: [],
  };
  const newContent = formatTopicPage(input);

  return {
    oldPath,
    newPath,
    slug,
    definition,
    definitionStatus,
    members,
    memberCount: members.length,
    skippedNoUrl,
    created,
    newContent,
  };
}

function runGit(vaultDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd: vaultDir });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const vault = new VaultFs(env.vaultDir);
  const store = new ArticleStore(dbPath);

  console.log(
    `[migrate-topics-v2] vault=${env.vaultDir} db=${dbPath} mode=${apply ? 'APPLY' : 'dry-run'}`,
  );

  const today = new Date();
  const allTopicPages = (await vault.list('wiki/topics/**/*.md')).filter(
    (p) => !p.includes('/archive/'),
  );
  console.log(`[migrate-topics-v2] discovered ${allTopicPages.length} topic page(s)`);

  // Phase 1: build a plan per page.
  const plans: PagePlan[] = [];
  for (const oldPath of allTopicPages) {
    const text = await vault.read(oldPath);
    const articles = store.findByPagePath(oldPath);
    plans.push(buildPlan(oldPath, text, articles, today));
  }

  // Phase 2: collision-resolve. Plans that don't win are dropped.
  const collision = planCollisions(
    plans.map((p) => ({ oldPath: p.oldPath, newPath: p.newPath, memberCount: p.memberCount })),
  );
  const resolvedKeys = new Set(collision.resolved.map((r) => `${r.oldPath}\0${r.newPath}`));
  const winners = plans.filter((p) => resolvedKeys.has(`${p.oldPath}\0${p.newPath}`));
  const losers = plans.filter((p) => !resolvedKeys.has(`${p.oldPath}\0${p.newPath}`));

  // Phase 3: report.
  const movedCount = winners.filter((p) => p.oldPath !== p.newPath).length;
  const inPlaceCount = winners.length - movedCount;
  let totalMembers = 0;
  let pagesWithDef = 0;
  let totalSkippedNoUrl = 0;
  for (const p of winners) {
    totalMembers += p.memberCount;
    if (p.definitionStatus === 'extracted') pagesWithDef++;
    totalSkippedNoUrl += p.skippedNoUrl;
    const arrow = p.oldPath === p.newPath ? 'in place' : `→ ${p.newPath}`;
    console.log(
      `[migrate-topics-v2] ${p.oldPath} ${arrow}  def=${p.definitionStatus}  members=${p.memberCount}` +
        (p.skippedNoUrl > 0 ? `  skipped-no-url=${p.skippedNoUrl}` : ''),
    );
  }

  if (collision.conflicts.length > 0) {
    console.log('');
    console.log(`[migrate-topics-v2] COLLISIONS (${collision.conflicts.length}):`);
    for (const c of collision.conflicts) {
      console.log(`  ${c.newPath} chosen=${c.chosen}`);
      for (const cand of c.candidates) {
        const tag = cand.oldPath === c.chosen ? '(WIN)' : '(drop)';
        console.log(`    ${tag} ${cand.oldPath} members=${cand.memberCount}`);
      }
    }
    console.log(`[migrate-topics-v2] dropped (collision losers): ${losers.length}`);
  }

  console.log('');
  console.log(
    `[migrate-topics-v2] summary: winners=${winners.length} moved=${movedCount} in-place=${inPlaceCount} ` +
      `with-def=${pagesWithDef} total-members=${totalMembers} skipped-no-url=${totalSkippedNoUrl} ` +
      `collision-losers=${losers.length}`,
  );

  if (!apply) {
    console.log('[migrate-topics-v2] dry run — no files written. Re-run with --apply to commit.');
    store.close();
    return;
  }

  // Phase 4: apply. Build the rename map (without `.md`) for the rewriter.
  const renameMap: RenameMap = new Map();
  for (const p of winners) {
    if (p.oldPath === p.newPath) continue;
    renameMap.set(stripMd(p.oldPath), stripMd(p.newPath));
  }

  // Move files first (git mv preserves history). For winners that stay in
  // place, no move needed — we just overwrite. For losers, we leave them
  // alone in this script (a subsequent cleanup pass can prune them once the
  // operator confirms the resolution).
  for (const p of winners) {
    if (p.oldPath === p.newPath) continue;
    // git mv into a deeper-or-shallower path requires the parent dir to exist.
    // For a flatten that's always wiki/topics/, which already exists.
    await runGit(env.vaultDir, ['mv', '-f', p.oldPath, p.newPath]);
  }

  // Write new content to the new (now-current) path.
  for (const p of winners) {
    await vault.write(p.newPath, p.newContent);
  }

  // Rewrite wikilinks across the entire wiki/.
  let filesScanned = 0;
  let filesUpdated = 0;
  if (renameMap.size > 0) {
    const allWiki = await vault.list('wiki/**/*.md');
    for (const path of allWiki) {
      filesScanned++;
      const text = await vault.read(path);
      const updated = rewriteWikilinks(text, renameMap);
      if (updated !== text) {
        await vault.write(path, updated);
        filesUpdated++;
      }
    }
  }

  console.log(
    `[migrate-topics-v2] wikilink rewrite: scanned=${filesScanned} updated=${filesUpdated}`,
  );

  const git = new GitOps({
    vaultDir: env.vaultDir,
    remote: env.vaultRemote,
    branch: env.vaultBranch,
  });
  const message = `migrate-topics-v2: flatten ${winners.length} topic pages, rewrite ${filesUpdated} wikilinks`;
  const result = await git.commit(message, ['wiki/']);
  if (result.committed) {
    console.log(`[migrate-topics-v2] committed ${result.sha?.slice(0, 7)} — ${message}`);
  } else {
    console.log('[migrate-topics-v2] git: no changes to commit');
  }

  store.close();
}

function stripMd(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path;
}

// Run only when invoked directly (e.g. `tsx src/migrate-topics-v2.ts`),
// not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-topics-v2.ts') ||
  process.argv[1]?.endsWith('migrate-topics-v2.js');

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[migrate-topics-v2] fatal:', err);
    process.exit(1);
  });
}


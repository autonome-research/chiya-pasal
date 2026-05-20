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
 *      Intermediate directory parts (e.g. `physics/` from
 *      `wiki/topics/physics/foo.md`) are lifted into a `clusters: [...]`
 *      frontmatter field — soft domain metadata, not a rigid taxonomy.
 *   3. Detect collisions; pick the winner by larger member count (lex
 *      tiebreak), then FOLD loser data into the winner: union clusters,
 *      union member lists, fall back to a non-empty loser definition if the
 *      winner's is empty. Loser files are removed with `git rm` in apply mode
 *      since their content is now redundant.
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

import { ArticleStore, type ArticleRow } from '../src/shared/article-store.js';
import { loadChiyaEnv } from '../src/shared/env.js';
import {
  formatTopicPage,
  stableIdForUrl,
  stableIdToFilename,
  type TopicPageInput,
} from '../src/phases/page-templates.js';
import { rewriteWikilinks, type RenameMap } from '../src/shared/wikilink-rewriter.js';
import { GitOps } from '../src/tools/git.js';
import { VaultFs } from '../src/tools/vault.js';

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

/**
 * Lift the intermediate directory parts of a `wiki/topics/<cluster>/.../foo.md`
 * path into a list of cluster slugs. The legacy structure used these dirs as
 * coarse domains (`physics/`, `ai-ml/`, etc.); the flat structure preserves
 * them as soft `clusters: [...]` metadata so retrieval/browsing keeps working
 * without rigidifying the taxonomy at the filesystem layer.
 *
 * - `wiki/topics/physics/quantum-sensing.md` → `['physics']`
 * - `wiki/topics/biology/digital-twin/foo.md` → `['biology', 'digital-twin']`
 * - `wiki/topics/quantum-sensing.md` → `[]` (already flat; no cluster signal)
 * - Paths outside `wiki/topics/` → `[]`
 */
export function clustersFromOldPath(oldPath: string): string[] {
  const normalized = oldPath.replace(/\\/g, '/');
  const prefix = 'wiki/topics/';
  if (!normalized.startsWith(prefix)) return [];
  const after = normalized.slice(prefix.length);
  const parts = after.split('/');
  if (parts.length <= 1) return [];
  return parts.slice(0, -1);
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
  clusters: string[];
  newContent: string;
}

/**
 * Fold the data from collision losers into a single winning plan: union
 * clusters, union member lists (dedupe by filename), and prefer the winner's
 * definition unless empty (then fall back to the longest non-empty loser).
 * The returned plan's `newContent` is re-rendered from the merged inputs.
 *
 * Exported for tests. `today` is the rendered `updated:` date — passed in
 * rather than read so unit tests can assert deterministic output.
 */
export function foldLosersIntoWinner(
  winner: PagePlan,
  losers: PagePlan[],
  today: Date,
): PagePlan {
  // Cluster union, order-preserving (winner first, then losers' uniques).
  const seenClusters = new Set<string>();
  const clusters: string[] = [];
  for (const c of winner.clusters) {
    if (!seenClusters.has(c)) {
      seenClusters.add(c);
      clusters.push(c);
    }
  }
  for (const l of losers) {
    for (const c of l.clusters) {
      if (!seenClusters.has(c)) {
        seenClusters.add(c);
        clusters.push(c);
      }
    }
  }

  // Member union by filename. Winner's entry wins on collision; otherwise
  // first-seen-from-losers wins.
  const memberMap = new Map<string, PagePlan['members'][0]>();
  for (const m of winner.members) memberMap.set(m.filename, m);
  for (const l of losers) {
    for (const m of l.members) {
      if (!memberMap.has(m.filename)) memberMap.set(m.filename, m);
    }
  }
  const members = [...memberMap.values()];

  // Definition: winner's if non-empty, otherwise longest non-empty from losers.
  let definition = winner.definition;
  let definitionStatus = winner.definitionStatus;
  if (definition.length === 0) {
    const candidates = losers
      .filter((l) => l.definition.length > 0)
      .sort((a, b) => b.definition.length - a.definition.length);
    if (candidates.length > 0) {
      definition = candidates[0]!.definition;
      definitionStatus = 'extracted';
    }
  }

  const skippedNoUrl =
    winner.skippedNoUrl + losers.reduce((sum, l) => sum + l.skippedNoUrl, 0);

  const input: TopicPageInput = {
    slug: winner.slug,
    created: winner.created,
    updated: today,
    definition,
    members,
    relatedTopics: [],
    clusters,
  };

  return {
    ...winner,
    definition,
    definitionStatus,
    members,
    memberCount: members.length,
    skippedNoUrl,
    clusters,
    newContent: formatTopicPage(input),
  };
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
  const clusters = clustersFromOldPath(oldPath);

  const input: TopicPageInput = {
    slug,
    created,
    updated: today,
    definition,
    members,
    relatedTopics: [],
    clusters,
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
    clusters,
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

  // Phase 2: collision-resolve, then fold loser data into the winners
  // (cluster union, member-list union, definition fallback) so no signal
  // from a losing plan is dropped on the floor.
  const collision = planCollisions(
    plans.map((p) => ({ oldPath: p.oldPath, newPath: p.newPath, memberCount: p.memberCount })),
  );
  const resolvedKeys = new Set(collision.resolved.map((r) => `${r.oldPath}\0${r.newPath}`));
  const rawWinners = plans.filter((p) => resolvedKeys.has(`${p.oldPath}\0${p.newPath}`));
  const losers = plans.filter((p) => !resolvedKeys.has(`${p.oldPath}\0${p.newPath}`));

  // Group losers by newPath so we can find which losers fold into which winner.
  const losersByNewPath = new Map<string, PagePlan[]>();
  for (const l of losers) {
    const arr = losersByNewPath.get(l.newPath) ?? [];
    arr.push(l);
    losersByNewPath.set(l.newPath, arr);
  }
  const winners: PagePlan[] = rawWinners.map((w) => {
    const ls = losersByNewPath.get(w.newPath) ?? [];
    return ls.length > 0 ? foldLosersIntoWinner(w, ls, today) : w;
  });

  // Phase 3: report.
  const movedCount = winners.filter((p) => p.oldPath !== p.newPath).length;
  const inPlaceCount = winners.length - movedCount;
  let totalMembers = 0;
  let pagesWithDef = 0;
  let totalSkippedNoUrl = 0;
  let pagesWithClusters = 0;
  for (const p of winners) {
    totalMembers += p.memberCount;
    if (p.definitionStatus === 'extracted') pagesWithDef++;
    if (p.clusters.length > 0) pagesWithClusters++;
    totalSkippedNoUrl += p.skippedNoUrl;
    const arrow = p.oldPath === p.newPath ? 'in place' : `→ ${p.newPath}`;
    const clusterTag = p.clusters.length > 0 ? `  clusters=[${p.clusters.join(',')}]` : '';
    console.log(
      `[migrate-topics-v2] ${p.oldPath} ${arrow}  def=${p.definitionStatus}  members=${p.memberCount}` +
        clusterTag +
        (p.skippedNoUrl > 0 ? `  skipped-no-url=${p.skippedNoUrl}` : ''),
    );
  }

  if (collision.conflicts.length > 0) {
    console.log('');
    console.log(`[migrate-topics-v2] COLLISIONS (${collision.conflicts.length}, folded into winners):`);
    for (const c of collision.conflicts) {
      const winner = winners.find((w) => w.newPath === c.newPath);
      const foldedClusters = winner ? `  clusters=[${winner.clusters.join(',')}]` : '';
      console.log(`  ${c.newPath} chosen=${c.chosen}${foldedClusters}`);
      for (const cand of c.candidates) {
        const tag = cand.oldPath === c.chosen ? '(WIN)' : '(fold)';
        console.log(`    ${tag} ${cand.oldPath} members=${cand.memberCount}`);
      }
    }
    console.log(`[migrate-topics-v2] folded losers (will be git rm'd on --apply): ${losers.length}`);
  }

  console.log('');
  console.log(
    `[migrate-topics-v2] summary: winners=${winners.length} moved=${movedCount} in-place=${inPlaceCount} ` +
      `with-def=${pagesWithDef} with-clusters=${pagesWithClusters} total-members=${totalMembers} ` +
      `skipped-no-url=${totalSkippedNoUrl} folded-losers=${losers.length}`,
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

  // Order matters here. Some losers' oldPaths already sit at the flat
  // wiki/topics/<slug>.md location that a winner is about to move INTO
  // (e.g. winner=wiki/topics/cybersecurity/iot-security.md,
  // loser=wiki/topics/iot-security.md). If we mv the winner first, git mv -f
  // overwrites the loser file with the winner's content — and the subsequent
  // git rm of the loser's oldPath then deletes the winner we just placed.
  // Removing losers FIRST avoids that race: the path is clear before any
  // winner moves into it.
  for (const l of losers) {
    await runGit(env.vaultDir, ['rm', '-f', l.oldPath]);
  }

  // Move files (git mv preserves history). For winners that stay in place,
  // no move needed — we just overwrite their content below.
  for (const p of winners) {
    if (p.oldPath === p.newPath) continue;
    // git mv into a deeper-or-shallower path requires the parent dir to exist.
    // For a flatten that's always wiki/topics/, which already exists.
    await runGit(env.vaultDir, ['mv', '-f', p.oldPath, p.newPath]);
  }

  // Write new content to the new (now-current) path. Winners that folded
  // loser data carry the merged member-lists + cluster unions here.
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
  const message =
    `migrate-topics-v2: flatten ${winners.length} topic pages` +
    (losers.length > 0 ? `, fold ${losers.length} collision losers` : '') +
    `, rewrite ${filesUpdated} wikilinks`;
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


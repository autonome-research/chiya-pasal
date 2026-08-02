#!/usr/bin/env tsx
/**
 * Recover lost `clusters:` metadata on flat topic pages from git history.
 *
 * Topic pages used to live in domain subdirectories (`wiki/topics/ai-ml/`,
 * `wiki/topics/physics/`, …). The flattening migration lifted those directory
 * names into `clusters: [...]` frontmatter — but only for the pages it moved.
 * Pages created flat, pages restored from elsewhere, and anything the
 * migration missed lost the signal entirely, and the flat namespace has no
 * other record of it. Git does: the ADD of the original nested path is still
 * in the log even though the directories are now empty.
 *
 * So: read the log (read-only — `git log` and nothing else), map each slug
 * back to the domain it was born under, and write that domain into the page's
 * frontmatter. Pages with no nested history are reported and left untouched;
 * the reviewer assigns clusters for new topics going forward.
 *
 * Usage:
 *   tsx scripts/backfill-topic-clusters.ts --user <handle>            # dry run
 *   tsx scripts/backfill-topic-clusters.ts --user <handle> --execute  # write
 *
 * Dry run is the default and prints recoverable/unrecoverable counts plus
 * samples. Execute mode writes files but never touches git — committing the
 * result is the operator's call.
 */

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { loadChiyaEnvFor } from '../src/shared/env.js';

// ---- git history → cluster recovery (pure) --------------------------------

/** A topic slug's historical nested location. */
export interface RecoveredCluster {
  slug: string;
  /** Directory parts between `wiki/topics/` and the filename, outermost first. */
  clusters: string[];
  /** How many distinct historical paths agreed on this cluster list. */
  votes: number;
}

const TOPICS_PREFIX = 'wiki/topics/';

/**
 * Parse `git log --diff-filter=A --name-only --format=` output into slug →
 * cluster candidates.
 *
 * Only nested paths carry signal; a flat `wiki/topics/foo.md` add tells us
 * nothing. Historical paths sometimes lack the `.md` extension (an early
 * writer bug), so the extension is optional. When a slug was added under more
 * than one domain over its life, the most-attested cluster list wins with a
 * lexicographic tiebreak — same resolution rule the flattening migration used
 * for colliding pages, so the two agree on the same winner.
 */
export function recoverClustersFromLog(logOutput: string): Map<string, RecoveredCluster> {
  const votes = new Map<string, Map<string, number>>();

  for (const rawLine of logOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(TOPICS_PREFIX)) continue;
    const rest = line.slice(TOPICS_PREFIX.length);
    const parts = rest.split('/').filter((p) => p.length > 0);
    if (parts.length <= 1) continue; // already flat: no cluster signal

    const filename = parts[parts.length - 1]!;
    const slug = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
    if (slug.length === 0 || slug.startsWith('_')) continue;
    const clusters = parts.slice(0, -1);
    const key = clusters.join('/');

    const perSlug = votes.get(slug) ?? new Map<string, number>();
    perSlug.set(key, (perSlug.get(key) ?? 0) + 1);
    votes.set(slug, perSlug);
  }

  const out = new Map<string, RecoveredCluster>();
  for (const slug of [...votes.keys()].sort()) {
    const perSlug = votes.get(slug)!;
    const ranked = [...perSlug.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const [key, count] = ranked[0]!;
    out.set(slug, { slug, clusters: key.split('/'), votes: count });
  }
  return out;
}

/** `git log` over the topics tree. Read-only: no checkout, no commit, no gc. */
export function readTopicAddLog(vaultDir: string): string {
  return execFileSync(
    'git',
    ['log', '--diff-filter=A', '--name-only', '--format=', '--', TOPICS_PREFIX],
    { cwd: vaultDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

// ---- frontmatter injection (pure) -----------------------------------------

/**
 * Insert `clusters: [...]` into a page's frontmatter, creating the block when
 * the page has none.
 *
 * Everything else is preserved byte-for-byte: existing frontmatter lines keep
 * their order and spelling, and the body is untouched. A page that already has
 * a `clusters:` key is returned unchanged — the librarian owns clusters once
 * they exist, and this is a one-shot recovery for pages where the key is
 * missing entirely.
 */
export function injectClusters(text: string, clusters: string[]): string {
  if (clusters.length === 0) return text;
  const value = `clusters: [${clusters.join(', ')}]`;

  if (!text.startsWith('---\n')) {
    return `---\n${value}\n---\n\n${text}`;
  }
  const closeIdx = text.indexOf('\n---', 4);
  if (closeIdx < 0) {
    // Unterminated frontmatter: treat the whole file as body rather than
    // corrupting it with a second marker in the wrong place.
    return text;
  }

  const fmBlock = text.slice(4, closeIdx);
  const lines = fmBlock.split('\n');
  if (lines.some((l) => /^clusters:/.test(l))) return text;

  // Sit next to related_topics when present so the soft-metadata keys stay
  // adjacent; otherwise append at the end of the block.
  const relatedIdx = lines.findIndex((l) => /^related_topics:/.test(l));
  if (relatedIdx >= 0) lines.splice(relatedIdx, 0, value);
  else lines.push(value);

  return `---\n${lines.join('\n')}${text.slice(closeIdx)}`;
}

// ---- planning -------------------------------------------------------------

export type PageOutcome = 'recovered' | 'already-clustered' | 'unrecoverable';

export interface PagePlan {
  slug: string;
  path: string;
  outcome: PageOutcome;
  clusters: string[];
}

function hasClustersKey(text: string): boolean {
  if (!text.startsWith('---\n')) return false;
  const closeIdx = text.indexOf('\n---', 4);
  if (closeIdx < 0) return false;
  return /^clusters:/m.test(text.slice(4, closeIdx));
}

/**
 * Classify every flat topic page against the recovered history. Files starting
 * with `_` are generated artifacts (e.g. `_registry.md`) and are not topics.
 */
export function planBackfill(
  vaultDir: string,
  recovered: Map<string, RecoveredCluster>,
): PagePlan[] {
  const dir = join(vaultDir, 'wiki', 'topics');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();

  const plans: PagePlan[] = [];
  for (const name of names) {
    const slug = name.slice(0, -3);
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    if (hasClustersKey(text)) {
      plans.push({ slug, path, outcome: 'already-clustered', clusters: [] });
      continue;
    }
    const hit = recovered.get(slug);
    if (!hit) {
      plans.push({ slug, path, outcome: 'unrecoverable', clusters: [] });
      continue;
    }
    plans.push({ slug, path, outcome: 'recovered', clusters: hit.clusters });
  }
  return plans;
}

/** Write recovered clusters. Returns the number of files actually changed. */
export function applyBackfill(plans: PagePlan[]): number {
  let written = 0;
  for (const plan of plans) {
    if (plan.outcome !== 'recovered') continue;
    const text = readFileSync(plan.path, 'utf8');
    const updated = injectClusters(text, plan.clusters);
    if (updated === text) continue;
    writeFileSync(plan.path, updated);
    written++;
  }
  return written;
}

// ---- CLI ------------------------------------------------------------------

interface Args {
  user: string;
  execute: boolean;
}

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error(`Usage: tsx scripts/backfill-topic-clusters.ts --user <handle> [--execute]

Options:
  --user <handle>   Tenant whose vault to backfill (required)
  --execute         Write the recovered clusters (default: dry run)
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
    `[backfill-topic-clusters] user=${args.user} vault=${env.vaultDir} ` +
      `mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'}`,
  );

  const recovered = recoverClustersFromLog(readTopicAddLog(env.vaultDir));
  console.log(`[backfill-topic-clusters] slugs with nested history: ${recovered.size}`);

  const plans = planBackfill(env.vaultDir, recovered);
  const byOutcome = (o: PageOutcome): PagePlan[] => plans.filter((p) => p.outcome === o);
  const toRecover = byOutcome('recovered');
  const unrecoverable = byOutcome('unrecoverable');
  const already = byOutcome('already-clustered');

  console.log(
    `[backfill-topic-clusters] pages=${plans.length} recoverable=${toRecover.length} ` +
      `already-clustered=${already.length} unrecoverable=${unrecoverable.length}`,
  );

  const domainCounts = new Map<string, number>();
  for (const p of toRecover) {
    const domain = p.clusters[0]!;
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }
  if (domainCounts.size > 0) {
    console.log('[backfill-topic-clusters] recoverable by domain:');
    for (const [domain, count] of [...domainCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${domain}: ${count}`);
    }
  }

  for (const p of toRecover.slice(0, SAMPLE_SIZE)) {
    console.log(`  recover ${p.slug} → clusters: [${p.clusters.join(', ')}]`);
  }
  for (const p of unrecoverable.slice(0, SAMPLE_SIZE)) {
    console.log(`  no history ${p.slug}`);
  }

  if (!args.execute) {
    console.log('[backfill-topic-clusters] dry run — no files written. Re-run with --execute.');
    return;
  }

  const written = applyBackfill(toRecover);
  console.log(`[backfill-topic-clusters] wrote ${written} page(s); git left untouched.`);
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-topic-clusters.ts') ||
  process.argv[1]?.endsWith('backfill-topic-clusters.js');

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[backfill-topic-clusters] fatal:', err);
    process.exit(1);
  }
}

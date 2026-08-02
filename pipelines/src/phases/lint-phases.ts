/**
 * Lint phases — the vault's "organize" organ.
 *
 * Everything here is deterministic: no LLM call, no invented content. Each
 * pass either regenerates a derived artifact from what the vault already
 * says (registry, index, graph), corrects a counter the writers cannot
 * maintain incrementally (`cited_by`), re-orders lines that already exist
 * (topic member lists), or reports without touching anything (pass 6).
 *
 * Phase order matters and is enforced by `requireCtx`:
 *
 *   scan-vault        one read of wiki/sources + wiki/topics into LintCtx
 *   regen-registry    wiki/topics/_registry.md + registry.json
 *   recount-citations cited_by frontmatter ← inbound `cites:` edges
 *   rank-topic-members member lines re-sorted by (cited_by, collected)
 *   regen-index       index.md as a navigation surface
 *   export-graph      graph.json for the visualization tool
 *   report-lint       broken links / orphans / stubs / near-duplicates
 *   commit-lint       one commit for the whole run
 *
 * The scan is the reason this is one pipeline rather than six scripts: the
 * live vault is 21.8k source pages and 2.6k topic pages, and reading them
 * once per pass would be five extra full walks per day.
 *
 * Writes go through `planWrite`, which compares against current content
 * first — an unchanged vault produces zero writes and an empty commit, so
 * the daily timer does not churn git history.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { requireCtx, type BasePipelineContext, type Phase } from 'thread-phase';

import {
  nearestSlugs,
  parseTopicPage,
  readFrontmatterList,
  renderRegistryJson,
  renderRegistryMarkdown,
  splitFrontmatter,
  orderedClusterNames,
  type TopicRecord,
  type TopicRegistry,
} from '../shared/topic-registry.js';
import {
  buildVaultGraph,
  renderGraphJson,
  type GraphSourceInput,
  type GraphTopicInput,
} from '../shared/graph-export.js';
import { bumpFrontmatterField } from './page-templates.js';
import type { GitOps } from '../tools/git.js';
import type { VaultFs } from '../tools/vault.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface LintSourceRecord {
  /** Filename without `wiki/sources/` and `.md`. */
  name: string;
  title: string;
  /** `collected:` frontmatter (YYYY-MM-DD) or null on legacy pages. */
  collected: string | null;
  topics: string[];
  cites: string[];
  related: string[];
  /** Entity page names linked anywhere in the page. */
  entities: string[];
  rigor: number | null;
  /** `cited_by:` as found on disk; null when the key is absent entirely. */
  citedBy: number | null;
  /** False for the handful of legacy pages with no frontmatter block. */
  hasFrontmatter: boolean;
  /** Every `[[wiki/...]]` target on the page, for broken-link detection. */
  links: string[];
}

export interface LintTopicPage {
  slug: string;
  record: TopicRecord;
  members: string[];
  relatedTopics: string[];
  links: string[];
  /** Retained from the scan: topic pages are 13 MB total, cheap to hold. */
  text: string;
}

export interface LintWriteLog {
  written: string[];
  wouldWrite: string[];
  unchanged: number;
}

export interface LintReport {
  /** Distinct missing targets, most-referenced first. */
  brokenLinks: Array<{ target: string; refCount: number; sample: string }>;
  /** Total broken link occurrences (not distinct targets). */
  brokenLinkTotal: number;
  /** Sources with no inbound member or cites edge. */
  orphanSources: string[];
  /** Topics with <= 1 member. */
  stubTopics: string[];
  /** Slug pairs close enough to be the same topic under two names. */
  duplicateTopics: Array<{ a: string; b: string }>;
}

export interface LintCtx extends BasePipelineContext {
  /** Report every would-write without touching the vault. */
  dryRun: boolean;
  /** One stamp for every artifact in a run, so they agree with each other. */
  generatedAt: string;
  /** Wall clock for the log entry; injected so tests are stable. */
  now: Date;
  sources?: LintSourceRecord[];
  topics?: LintTopicPage[];
  /** Page names under `wiki/entities/`. */
  entities?: string[];
  /** Other `wiki/<dir>` page families, for index navigation. */
  families?: Array<{ dir: string; pages: string[] }>;
  /** Recomputed in-degree per source name — the truth `cited_by` is bumped to. */
  inDegree?: Map<string, number>;
  registry?: TopicRegistry;
  writes?: LintWriteLog;
  report?: LintReport;
  /** Rolled-up counters for the log entry and the job summary. */
  stats: Record<string, number>;
}

const SOURCES_DIR = join('wiki', 'sources');
const TOPICS_DIR = join('wiki', 'topics');
const ENTITIES_DIR = join('wiki', 'entities');
const WIKI_DIR = 'wiki';

/** Files touched per heartbeat tick inside the long scan/rewrite loops. */
const HEARTBEAT_EVERY = 500;

/** Cap on per-category lists carried in the report event payload. The job
 *  store persists every event, and the live vault can produce five-figure
 *  orphan lists; the full counts are always exact, only the enumeration is
 *  truncated. */
export const MAX_REPORT_ITEMS = 2000;

/** Offenders named inline in the log.md entry. */
const TOP_OFFENDERS = 5;

// ---------------------------------------------------------------------------
// Pure parsing helpers
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[\s*([^\]|#]+?)\s*(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Every wikilink target on a page, `.md` stripped, in first-seen order. */
export function wikilinkTargets(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    let target = m[1]!.trim();
    if (target.endsWith('.md')) target = target.slice(0, -3);
    if (target.length === 0 || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

function underPrefix(targets: string[], prefix: string): string[] {
  return targets.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseSourcePage(name: string, text: string): LintSourceRecord {
  const fm = splitFrontmatter(text);
  const hasFrontmatter = text.startsWith('---\n') && fm.body !== text;
  const links = wikilinkTargets(text);
  const h1 = /^#\s+(.+)$/m.exec(fm.body);
  const rawTitle = fm.scalars.get('title');

  return {
    name,
    title: rawTitle ? unquote(rawTitle) : h1 ? h1[1]!.trim() : name,
    collected: fm.scalars.get('collected') ? unquote(fm.scalars.get('collected')!) : null,
    topics: readFrontmatterList(fm, 'topics'),
    cites: readFrontmatterList(fm, 'cites'),
    related: readFrontmatterList(fm, 'related'),
    entities: underPrefix(links, `${ENTITIES_DIR}/`),
    rigor: parseIntOrNull(fm.scalars.get('rigor')),
    citedBy: parseIntOrNull(fm.scalars.get('cited_by')),
    hasFrontmatter,
    links,
  };
}

// ---------------------------------------------------------------------------
// Member re-ranking (pure)
// ---------------------------------------------------------------------------

const MEMBER_HEADING = '## Member sources';
const MEMBER_LINE_RE = /^- \[\[wiki\/sources\/([^\]|#]+?)\]\](.*)$/;
const MEMBER_DATE_RE = /\((\d{4}-\d{2}-\d{2})\)\s*$/;
const NONE_PLACEHOLDER = /^_None( yet)?\._$/;

export type RerankStatus = 'reordered' | 'unchanged' | 'no-section' | 'unparseable';

export interface MemberSortKey {
  citedBy: number;
  collected: string;
}

/**
 * Re-sort a topic page's member list by (cited_by desc, collected desc, name asc).
 *
 * Only existing lines move: the sorted lines are written back into the exact
 * indices they occupied, so blank lines, headings, and everything outside the
 * member section survive byte-for-byte. A section containing anything other
 * than member lines and the `_None yet._` placeholder is left untouched and
 * reported — a topic page with hand-written prose in its member list is not
 * ours to rewrite.
 */
export function rerankMemberSection(
  text: string,
  keyOf: (sourceName: string, lineDate: string | null) => MemberSortKey,
): { text: string; status: RerankStatus } {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith(MEMBER_HEADING));
  if (headerIdx < 0) return { text, status: 'no-section' };

  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      endIdx = i;
      break;
    }
  }

  const slots: number[] = [];
  const entries: Array<{ line: string; key: MemberSortKey; name: string }> = [];
  for (let i = headerIdx + 1; i < endIdx; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || NONE_PLACEHOLDER.test(line.trim())) continue;
    const m = MEMBER_LINE_RE.exec(line);
    if (!m) return { text, status: 'unparseable' };
    const name = m[1]!.trim();
    const dateMatch = MEMBER_DATE_RE.exec(m[2]!);
    slots.push(i);
    entries.push({ line, key: keyOf(name, dateMatch ? dateMatch[1]! : null), name });
  }
  if (entries.length < 2) return { text, status: 'unchanged' };

  const sorted = [...entries].sort((a, b) => {
    if (b.key.citedBy !== a.key.citedBy) return b.key.citedBy - a.key.citedBy;
    if (a.key.collected !== b.key.collected) return a.key.collected < b.key.collected ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    if (sorted[i]!.line !== lines[slots[i]!]) changed = true;
    lines[slots[i]!] = sorted[i]!.line;
  }
  return changed ? { text: lines.join('\n'), status: 'reordered' } : { text, status: 'unchanged' };
}

// ---------------------------------------------------------------------------
// index.md (pure)
// ---------------------------------------------------------------------------

/** Topics listed per cluster before deferring to the registry page. */
const INDEX_TOPICS_PER_CLUSTER = 20;
/** Sources listed under "Recent additions". */
const INDEX_RECENT_SOURCES = 30;
/** A page family this small is enumerated inline; larger ones get a count. */
const INDEX_FAMILY_INLINE_MAX = 25;
/** Pseudo-cluster for topics with no `clusters:` frontmatter. */
const UNCLUSTERED_GROUP = '(unclustered)';

export interface IndexInput {
  generatedAt: string;
  registry: TopicRegistry;
  sources: LintSourceRecord[];
  entities: string[];
  families: Array<{ dir: string; pages: string[] }>;
}

function byMemberCountDesc(a: TopicRecord, b: TopicRecord): number {
  if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
  if (b.citedByTotal !== a.citedByTotal) return b.citedByTotal - a.citedByTotal;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Cluster groups in registry order, with the unclustered pile as a group. */
function indexGroups(reg: TopicRegistry): Array<{ name: string; topics: TopicRecord[] }> {
  const groups = orderedClusterNames(reg).map((name) => ({
    name,
    topics: reg.topics.filter((t) => t.clusters.includes(name)).sort(byMemberCountDesc),
  }));
  const loose = reg.topics.filter((t) => t.clusters.length === 0).sort(byMemberCountDesc);
  if (loose.length > 0) groups.push({ name: UNCLUSTERED_GROUP, topics: loose });
  return groups;
}

/**
 * The vault's front door.
 *
 * Deliberately NOT a catalog: 21.8k source pages cannot be listed, and the
 * old hand-maintained index that tried died in May. This is a navigation
 * surface — clusters down to their biggest topics, the newest sources, the
 * other page families, and pointers to the machine-readable views.
 */
export function renderIndexMarkdown(input: IndexInput): string {
  const { registry: reg } = input;
  const uncategorized = input.sources.filter(
    (s) => s.topics.length === 0 || s.topics.includes('uncategorized'),
  ).length;

  const out: string[] = [
    '---',
    'type: index',
    'status: generated',
    `generated: ${input.generatedAt}`,
    '---',
    '',
    '# Wiki Index',
    '',
    'Navigation surface for this vault, regenerated by `chiya-lint`. **Do not hand-edit**',
    '— every run rewrites it from the pages themselves.',
    '',
    'This is not a catalog: the full topic vocabulary lives in [[wiki/topics/_registry]],',
    'and machine-readable views live in `registry.json` (topics) and `graph.json`',
    '(nodes and edges for the whole vault).',
    '',
    '## Clusters',
    '',
  ];

  const groups = indexGroups(reg);
  if (groups.length === 0) {
    out.push('_No topics yet._', '');
  } else {
    for (const group of groups) {
      out.push(`### ${group.name} (${group.topics.length})`, '');
      for (const t of group.topics.slice(0, INDEX_TOPICS_PER_CLUSTER)) {
        out.push(`- [[wiki/topics/${t.slug}]] — ${t.memberCount} sources`);
      }
      const rest = group.topics.length - INDEX_TOPICS_PER_CLUSTER;
      if (rest > 0) out.push(`- …and ${rest} more in [[wiki/topics/_registry]]`);
      out.push('');
    }
  }

  out.push('## Other page families', '');
  if (input.families.length === 0) {
    out.push('_None._', '');
  } else {
    for (const family of input.families) {
      if (family.pages.length <= INDEX_FAMILY_INLINE_MAX) {
        out.push(`### ${family.dir} (${family.pages.length})`, '');
        for (const page of family.pages) out.push(`- [[wiki/${family.dir}/${page}]]`);
      } else {
        out.push(`### ${family.dir} (${family.pages.length})`, '', `\`wiki/${family.dir}/\` — ${family.pages.length} pages.`);
      }
      out.push('');
    }
  }

  out.push('## Recent additions', '');
  const recent = [...input.sources]
    .sort((a, b) => {
      const ca = a.collected ?? '';
      const cb = b.collected ?? '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, INDEX_RECENT_SOURCES);
  if (recent.length === 0) {
    out.push('_None._', '');
  } else {
    for (const s of recent) {
      out.push(`- [[wiki/sources/${s.name}]] — ${s.title}${s.collected ? ` (${s.collected})` : ''}`);
    }
    out.push('');
  }

  out.push(
    '## Stats',
    '',
    `- Sources: ${input.sources.length}`,
    `- Topics: ${reg.topics.length}`,
    `- Clusters: ${Object.keys(reg.clusters).length}`,
    `- Unclustered topics: ${reg.topics.filter((t) => t.clusters.length === 0).length}`,
    `- Sources with no topic assigned: ${uncategorized}`,
    `- Entities: ${input.entities.length}`,
    `- Generated: ${input.generatedAt}`,
    '',
  );

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

/** Token blocks larger than this carry no duplicate signal (`quantum` is in
 *  hundreds of slugs) and are skipped, keeping the pairwise comparison from
 *  degenerating into 2.6k × 2.6k edit distances. */
const MAX_TOKEN_BLOCK = 400;
/** Nearest-slug candidates considered per topic. */
const DUPLICATE_CANDIDATES = 3;

/**
 * Acceptance gate on top of `nearestSlugs`.
 *
 * `nearestSlugs` answers a recall-first question ("did the reviewer mean one
 * of these existing slugs?") and floors similarity at 0.25, where any two
 * two-token slugs sharing a token still qualify. Asked for duplicates on the
 * live vault that yields 4.7k pairs like `2d-graphene-physics ↔ axion-physics`
 * — noise that would bury the real hits (`agent-memory ↔ agent-memories`).
 *
 * The gate compares only the tokens the two slugs do NOT share, which is what
 * separates a spelling variant from a sibling: `agent-{memory|memories}` differ
 * by `memory` vs `memories` (0.75), while `{axion|particle}-physics` differ by
 * `axion` vs `particle` (0.1). Whole-slug similarity cannot tell those apart —
 * both score ~0.62 — because the shared token dominates.
 *
 * Broader/narrower pairs (`3d-reconstruction` ⊂ `3d-surface-reconstruction`)
 * are deliberately NOT reported: one side's difference is empty, they are not
 * merge candidates, and on the live vault they would flood the report with
 * every `*-physics` topic paired against `physics`.
 */
const DUPLICATE_MIN_EDIT_SIMILARITY = 0.6;

function slugTokens(slug: string): string[] {
  return slug.split('-').filter((s) => s.length > 0);
}

function isDuplicateCandidate(a: string, b: string): boolean {
  const ta = new Set(slugTokens(a));
  const tb = new Set(slugTokens(b));
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (onlyA.length === 0 || onlyB.length === 0) return false;
  return editSimilarity(onlyA.join('-'), onlyB.join('-')) >= DUPLICATE_MIN_EDIT_SIMILARITY;
}

function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length]! / maxLen;
}

/**
 * Near-duplicate topic slugs, via `nearestSlugs` over a token-blocked pool.
 *
 * `nearestSlugs` scans the whole registry, so calling it once per topic on the
 * live vault would be ~6.8M edit-distance computations. Blocking by shared
 * token first cuts that to the pairs that could plausibly score above the
 * similarity floor, and the scoring itself stays the wave-1 contract's.
 */
export function duplicateTopicCandidates(reg: TopicRegistry): Array<{ a: string; b: string }> {
  const byToken = new Map<string, TopicRecord[]>();
  for (const t of reg.topics) {
    for (const token of new Set(slugTokens(t.slug))) {
      const arr = byToken.get(token) ?? [];
      arr.push(t);
      byToken.set(token, arr);
    }
  }

  const pairs = new Map<string, { a: string; b: string }>();
  for (const t of reg.topics) {
    const pool = new Map<string, TopicRecord>();
    for (const token of new Set(slugTokens(t.slug))) {
      const block = byToken.get(token) ?? [];
      if (block.length > MAX_TOKEN_BLOCK) continue;
      for (const other of block) if (other.slug !== t.slug) pool.set(other.slug, other);
    }
    if (pool.size === 0) continue;
    const mini: TopicRegistry = {
      topics: [...pool.values()].sort((x, y) => (x.slug < y.slug ? -1 : 1)),
      clusters: {},
      generatedAt: reg.generatedAt,
    };
    for (const near of nearestSlugs(mini, t.slug, DUPLICATE_CANDIDATES)) {
      if (!isDuplicateCandidate(t.slug, near)) continue;
      const [a, b] = t.slug < near ? [t.slug, near] : [near, t.slug];
      pairs.set(`${a}|${b}`, { a: a!, b: b! });
    }
  }

  return [...pairs.values()].sort((x, y) => (x.a !== y.a ? (x.a < y.a ? -1 : 1) : x.b < y.b ? -1 : 1));
}

export interface ReportInput {
  sources: LintSourceRecord[];
  topics: LintTopicPage[];
  registry: TopicRegistry;
  /** Does this wikilink target resolve to a page? DI seam for tests. */
  pageExists: (target: string) => boolean;
}

export function computeLintReport(input: ReportInput): LintReport {
  // Broken links: only path-style `wiki/...` targets are checkable. Obsidian
  // short links (`[[Samsung]]`) resolve by filename search anywhere in the
  // vault, so treating them as broken would report thousands of false hits.
  const broken = new Map<string, { refCount: number; sample: string }>();
  let brokenLinkTotal = 0;
  const noteLinks = (from: string, links: string[]): void => {
    for (const target of links) {
      if (!target.startsWith(`${WIKI_DIR}/`)) continue;
      if (input.pageExists(target)) continue;
      brokenLinkTotal++;
      const entry = broken.get(target);
      if (entry) entry.refCount++;
      else broken.set(target, { refCount: 1, sample: from });
    }
  };
  for (const s of input.sources) noteLinks(`${SOURCES_DIR}/${s.name}`, s.links);
  for (const t of input.topics) noteLinks(`${TOPICS_DIR}/${t.slug}`, t.links);

  const inbound = new Set<string>();
  for (const t of input.topics) for (const m of t.members) inbound.add(m);
  for (const s of input.sources) for (const c of s.cites) inbound.add(c);

  const orphanSources = input.sources
    .filter((s) => !inbound.has(s.name))
    .map((s) => s.name)
    .sort();

  const stubTopics = input.registry.topics
    .filter((t) => t.memberCount <= 1)
    .map((t) => t.slug)
    .sort();

  return {
    brokenLinks: [...broken.entries()]
      .map(([target, v]) => ({ target, refCount: v.refCount, sample: v.sample }))
      .sort((a, b) =>
        b.refCount !== a.refCount ? b.refCount - a.refCount : a.target < b.target ? -1 : 1,
      ),
    brokenLinkTotal,
    orphanSources,
    stubTopics,
    duplicateTopics: duplicateTopicCandidates(input.registry),
  };
}

/** `YYYY-MM-DD HH:MM` in local time, matching the existing log.md entries. */
export function localStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderLogEntry(
  now: Date,
  stats: Record<string, number>,
  report: LintReport,
): string {
  const head =
    `## [${localStamp(now)}] lint | ` +
    `${stats.topics ?? 0} topics · ${stats.sources ?? 0} sources · ` +
    `${stats.citedByUpdated ?? 0} cited_by fixed · ${stats.membersReranked ?? 0} topics reranked · ` +
    `${stats.filesWritten ?? 0} files written`;

  const top = <T>(items: T[], render: (item: T) => string): string =>
    items.length === 0 ? '—' : items.slice(0, TOP_OFFENDERS).map(render).join(', ');

  return [
    head,
    '',
    `- broken wikilinks: ${report.brokenLinkTotal} across ${report.brokenLinks.length} targets (top: ${top(report.brokenLinks, (b) => `${b.target} ×${b.refCount}`)})`,
    `- orphan sources: ${report.orphanSources.length} (top: ${top(report.orphanSources, (o) => o)})`,
    `- stub topics: ${report.stubTopics.length} (top: ${top(report.stubTopics, (s) => s)})`,
    `- near-duplicate topics: ${report.duplicateTopics.length} (top: ${top(report.duplicateTopics, (d) => `${d.a} ↔ ${d.b}`)})`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Write plumbing
// ---------------------------------------------------------------------------

function writeLog(ctx: LintCtx): LintWriteLog {
  if (!ctx.writes) ctx.writes = { written: [], wouldWrite: [], unchanged: 0 };
  return ctx.writes;
}

/**
 * Write only when the bytes actually change, and never in dry-run.
 *
 * Content-comparison is what makes a daily timer safe on a 21.8k-page vault:
 * a run over an unchanged vault touches nothing, so `git add` finds nothing
 * and the commit is a no-op instead of 21.8k identical-content mtime churn.
 */
/** The generatedAt stamp in each generated artifact (registry md/json,
 *  index.md, graph.json). Stripped before content comparison so a run over an
 *  unchanged vault is a no-op — otherwise the fresh timestamp alone would
 *  force all four artifacts (and a commit) every night. */
const GENERATED_STAMP_RE =
  /("generatedAt": "|generated: |- Generated: )\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g;

function withoutStamp(content: string): string {
  return content.replace(GENERATED_STAMP_RE, '$1<stamp>');
}

async function planWrite(
  ctx: LintCtx,
  vault: VaultFs,
  path: string,
  content: string,
  /** Current contents when the caller has already read them (the recount pass
   *  reads every stale page to rewrite it) — saves a second read per file. */
  known?: string,
): Promise<'written' | 'unchanged' | 'would-write'> {
  const log = writeLog(ctx);
  const current = known ?? (await vault.readOptional(path));
  if (current === content || (current !== null && withoutStamp(current) === withoutStamp(content))) {
    log.unchanged++;
    return 'unchanged';
  }
  if (ctx.dryRun) {
    log.wouldWrite.push(path);
    return 'would-write';
  }
  await vault.write(path, content);
  log.written.push(path);
  return 'written';
}

function bump(ctx: LintCtx, key: string, by = 1): void {
  ctx.stats[key] = (ctx.stats[key] ?? 0) + by;
}

// ---------------------------------------------------------------------------
// Pass 0 — scan-vault
// ---------------------------------------------------------------------------

function listPages(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
      .map((e) => e.name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Cluster → topic count, alphabetical keys (mirrors scanTopicRegistry). */
function clusterCounts(records: TopicRecord[]): Record<string, { topicCount: number }> {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const c of new Set(r.clusters)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const out: Record<string, { topicCount: number }> = {};
  for (const name of [...counts.keys()].sort()) out[name] = { topicCount: counts.get(name)! };
  return out;
}

/**
 * One walk of the vault into LintCtx.
 *
 * Source pages are read whole (87 MB across 21.9k files on the live vault —
 * a couple of seconds) rather than head-only, because the later passes need
 * body wikilinks for broken-link and entity-mention detection, and a second
 * walk would cost more than the extra bytes.
 *
 * The registry is assembled here from `parseTopicPage` instead of calling
 * `scanTopicRegistry`: that helper derives `citedByTotal` by re-reading every
 * member source's frontmatter, which would be a second pass over the same
 * 21.9k files AND would read the pre-recount values. Building it here lets
 * `citedByTotal` reflect the in-degree this very run computes.
 */
export const scanVault = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'scan-vault',
  async *run(ctx) {
    const root = vault.rootDir;

    const sources: LintSourceRecord[] = [];
    const inDegree = new Map<string, number>();
    const sourceNames = listPages(join(root, SOURCES_DIR));
    let scanned = 0;
    for (const name of sourceNames) {
      let text: string;
      try {
        text = readFileSync(join(root, SOURCES_DIR, `${name}.md`), 'utf8');
      } catch {
        continue;
      }
      const record = parseSourcePage(name, text);
      sources.push(record);
      // Dedupe within a page: citing the same source twice is one edge.
      for (const cited of new Set(record.cites)) {
        inDegree.set(cited, (inDegree.get(cited) ?? 0) + 1);
      }
      if (++scanned % HEARTBEAT_EVERY === 0) await ctx.heartbeat?.();
    }

    const topics: LintTopicPage[] = [];
    for (const slug of listPages(join(root, TOPICS_DIR))) {
      let text: string;
      try {
        text = readFileSync(join(root, TOPICS_DIR, `${slug}.md`), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseTopicPage(slug, text);
      const fm = splitFrontmatter(text);
      topics.push({
        slug,
        record: parsed.record,
        members: parsed.members,
        relatedTopics: readFrontmatterList(fm, 'related_topics'),
        links: wikilinkTargets(text),
        text,
      });
    }

    // citedByTotal from this run's in-degree, not from possibly-stale pages.
    for (const t of topics) {
      t.record.citedByTotal = t.members.reduce((s, m) => s + (inDegree.get(m) ?? 0), 0);
    }

    const entities = listPages(join(root, ENTITIES_DIR));
    const families: Array<{ dir: string; pages: string[] }> = [];
    try {
      for (const entry of readdirSync(join(root, WIKI_DIR), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'sources' || entry.name === 'topics') continue;
        const pages = listPages(join(root, WIKI_DIR, entry.name));
        if (pages.length > 0) families.push({ dir: entry.name, pages });
      }
    } catch {
      // No wiki/ directory at all is a legitimate fresh-vault state.
    }
    families.sort((a, b) => (a.dir < b.dir ? -1 : 1));

    ctx.sources = sources;
    ctx.topics = topics;
    ctx.entities = entities;
    ctx.families = families;
    ctx.inDegree = inDegree;
    ctx.registry = {
      topics: topics.map((t) => t.record),
      clusters: clusterCounts(topics.map((t) => t.record)),
      generatedAt: ctx.generatedAt,
    };

    ctx.stats.sources = sources.length;
    ctx.stats.topics = topics.length;
    ctx.stats.entities = entities.length;
    ctx.stats.clusters = Object.keys(ctx.registry.clusters).length;

    yield {
      type: 'phase',
      phase: 'scan-vault',
      detail: `${sources.length} sources, ${topics.length} topics, ${entities.length} entities`,
      counts: {
        sources: sources.length,
        topics: topics.length,
        entities: entities.length,
        clusters: Object.keys(ctx.registry.clusters).length,
        citeEdges: [...inDegree.values()].reduce((a, b) => a + b, 0),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Pass 1 — regen-registry
// ---------------------------------------------------------------------------

export const REGISTRY_PAGE = join(TOPICS_DIR, '_registry.md');
export const REGISTRY_JSON = 'registry.json';
export const GRAPH_JSON = 'graph.json';
export const INDEX_PAGE = 'index.md';

export const regenRegistry = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'regen-registry',
  async *run(ctx) {
    const reg = requireCtx(ctx, 'registry', 'regen-registry');
    const page = await planWrite(ctx, vault, REGISTRY_PAGE, renderRegistryMarkdown(reg));
    const json = await planWrite(ctx, vault, REGISTRY_JSON, renderRegistryJson(reg));
    yield {
      type: 'phase',
      phase: 'regen-registry',
      detail: `${REGISTRY_PAGE}: ${page}, ${REGISTRY_JSON}: ${json}`,
      counts: {
        topics: reg.topics.length,
        clusters: Object.keys(reg.clusters).length,
        changed: (page === 'unchanged' ? 0 : 1) + (json === 'unchanged' ? 0 : 1),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Pass 2 — recount-citations
// ---------------------------------------------------------------------------

/**
 * Recompute `cited_by:` from inbound `cites:` edges.
 *
 * The librarian writes `cited_by: 0` at page birth and never increments it —
 * `appendCitedBy` only adds a bullet to the body — so the number is
 * lint-owned by design and is recomputed here rather than adjusted.
 *
 * Pages are rewritten via `bumpFrontmatterField`, which replaces the single
 * line in place (or appends it to the frontmatter block when missing), so the
 * rest of the page is preserved byte-for-byte. The ~21.8k legacy pages with
 * no `cited_by` key at all get one on the first run; pages with no
 * frontmatter block are left alone and counted.
 */
export const recountCitations = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'recount-citations',
  async *run(ctx) {
    const sources = requireCtx(ctx, 'sources', 'recount-citations');
    const inDegree = requireCtx(ctx, 'inDegree', 'recount-citations');

    let updated = 0;
    let added = 0;
    let skippedNoFrontmatter = 0;
    let processed = 0;
    for (const s of sources) {
      const fresh = inDegree.get(s.name) ?? 0;
      if (s.citedBy === fresh) continue;
      if (!s.hasFrontmatter) {
        skippedNoFrontmatter++;
        continue;
      }
      const path = join(SOURCES_DIR, `${s.name}.md`);
      const current = await vault.readOptional(path);
      if (current === null) continue;
      const next = bumpFrontmatterField(current, 'cited_by', fresh);
      const outcome = await planWrite(ctx, vault, path, next, current);
      if (outcome !== 'unchanged') {
        updated++;
        if (s.citedBy === null) added++;
      }
      // Keep the in-memory record consistent with what later passes assume.
      s.citedBy = fresh;
      if (++processed % HEARTBEAT_EVERY === 0) await ctx.heartbeat?.();
    }

    ctx.stats.citedByUpdated = updated;
    yield {
      type: 'phase',
      phase: 'recount-citations',
      detail: ctx.dryRun
        ? `dry-run: ${updated} source page(s) would get a corrected cited_by`
        : `${updated} source page(s) recounted`,
      counts: {
        updated,
        added,
        skippedNoFrontmatter,
        dryRun: ctx.dryRun ? 1 : 0,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Pass 3 — rank-topic-members
// ---------------------------------------------------------------------------

export const rankTopicMembers = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'rank-topic-members',
  async *run(ctx) {
    const topics = requireCtx(ctx, 'topics', 'rank-topic-members');
    const inDegree = requireCtx(ctx, 'inDegree', 'rank-topic-members');
    const sources = requireCtx(ctx, 'sources', 'rank-topic-members');
    const collectedByName = new Map(sources.map((s) => [s.name, s.collected]));

    const keyOf = (name: string, lineDate: string | null): MemberSortKey => ({
      citedBy: inDegree.get(name) ?? 0,
      // The scanned frontmatter wins over the date embedded in the member
      // line: the line is a copy made at write time and can be stale.
      collected: collectedByName.get(name) ?? lineDate ?? '',
    });

    let reordered = 0;
    let unparseable = 0;
    let noSection = 0;
    const unparseablePages: string[] = [];
    for (const t of topics) {
      const result = rerankMemberSection(t.text, keyOf);
      if (result.status === 'unparseable') {
        unparseable++;
        if (unparseablePages.length < MAX_REPORT_ITEMS) unparseablePages.push(t.slug);
        continue;
      }
      if (result.status === 'no-section') {
        noSection++;
        continue;
      }
      if (result.status !== 'reordered') continue;
      const outcome = await planWrite(ctx, vault, join(TOPICS_DIR, `${t.slug}.md`), result.text);
      if (outcome !== 'unchanged') reordered++;
      t.text = result.text;
    }

    ctx.stats.membersReranked = reordered;
    yield {
      type: 'phase',
      phase: 'rank-topic-members',
      detail: ctx.dryRun
        ? `dry-run: ${reordered} topic page(s) would be reordered`
        : `${reordered} topic page(s) reordered`,
      counts: { reordered, unparseable, noSection, dryRun: ctx.dryRun ? 1 : 0 },
    };
    if (unparseablePages.length > 0) {
      yield { type: 'data', key: 'lint-unparseable-member-sections', value: unparseablePages };
    }
  },
});

// ---------------------------------------------------------------------------
// Pass 4 — regen-index
// ---------------------------------------------------------------------------

export const regenIndex = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'regen-index',
  async *run(ctx) {
    const reg = requireCtx(ctx, 'registry', 'regen-index');
    const sources = requireCtx(ctx, 'sources', 'regen-index');
    const entities = requireCtx(ctx, 'entities', 'regen-index');
    const families = requireCtx(ctx, 'families', 'regen-index');

    const outcome = await planWrite(
      ctx,
      vault,
      INDEX_PAGE,
      renderIndexMarkdown({
        generatedAt: ctx.generatedAt,
        registry: reg,
        sources,
        entities,
        families,
      }),
    );
    yield {
      type: 'phase',
      phase: 'regen-index',
      detail: `${INDEX_PAGE}: ${outcome}`,
      counts: { changed: outcome === 'unchanged' ? 0 : 1 },
    };
  },
});

// ---------------------------------------------------------------------------
// Pass 5 — export-graph
// ---------------------------------------------------------------------------

export const exportGraph = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'export-graph',
  async *run(ctx) {
    const sources = requireCtx(ctx, 'sources', 'export-graph');
    const topics = requireCtx(ctx, 'topics', 'export-graph');
    const entities = requireCtx(ctx, 'entities', 'export-graph');
    const inDegree = requireCtx(ctx, 'inDegree', 'export-graph');

    const graphSources: GraphSourceInput[] = sources.map((s) => ({
      name: s.name,
      title: s.title,
      cites: s.cites,
      related: s.related,
      entities: s.entities,
      rigor: s.rigor,
      citedBy: inDegree.get(s.name) ?? 0,
    }));
    const graphTopics: GraphTopicInput[] = topics.map((t) => ({
      slug: t.slug,
      title: t.record.title,
      clusters: t.record.clusters,
      members: t.members,
      relatedTopics: t.relatedTopics,
    }));

    const graph = buildVaultGraph({
      generatedAt: ctx.generatedAt,
      sources: graphSources,
      topics: graphTopics,
      entities,
    });
    const outcome = await planWrite(ctx, vault, GRAPH_JSON, renderGraphJson(graph));

    ctx.stats.graphNodes = graph.stats.nodes;
    ctx.stats.graphEdges = graph.stats.edges;
    yield {
      type: 'phase',
      phase: 'export-graph',
      detail: `${GRAPH_JSON}: ${outcome} (${graph.stats.nodes} nodes, ${graph.stats.edges} edges)`,
      counts: { ...graph.stats, changed: outcome === 'unchanged' ? 0 : 1 },
    };
  },
});

// ---------------------------------------------------------------------------
// Pass 6 — report-lint (report only; Phase A deletes and merges nothing)
// ---------------------------------------------------------------------------

/** Page existence by wikilink target, memoized per run. */
function pageExistsFor(root: string): (target: string) => boolean {
  const cache = new Map<string, boolean>();
  return (target) => {
    let hit = cache.get(target);
    if (hit === undefined) {
      hit = existsSync(join(root, `${target}.md`)) || existsSync(join(root, target));
      cache.set(target, hit);
    }
    return hit;
  };
}

export const reportLint = (vault: VaultFs): Phase<LintCtx> => ({
  name: 'report-lint',
  async *run(ctx) {
    const sources = requireCtx(ctx, 'sources', 'report-lint');
    const topics = requireCtx(ctx, 'topics', 'report-lint');
    const reg = requireCtx(ctx, 'registry', 'report-lint');

    const report = computeLintReport({
      sources,
      topics,
      registry: reg,
      pageExists: pageExistsFor(vault.rootDir),
    });
    ctx.report = report;

    const log = writeLog(ctx);
    ctx.stats.filesWritten = ctx.dryRun ? log.wouldWrite.length : log.written.length;
    ctx.stats.brokenLinks = report.brokenLinkTotal;
    ctx.stats.orphanSources = report.orphanSources.length;
    ctx.stats.stubTopics = report.stubTopics.length;
    ctx.stats.duplicateTopics = report.duplicateTopics.length;

    const entry = renderLogEntry(ctx.now, ctx.stats, report);
    if (!ctx.dryRun) {
      await vault.append('log.md', `\n${entry}\n`);
      // The append is a vault write like any other — commit-lint keys its
      // no-op decision on written.length, and an entry left uncommitted would
      // ride shotgun in the next librarian/digest commit instead.
      log.written.push('log.md');
    }

    yield {
      type: 'phase',
      phase: 'report-lint',
      detail: ctx.dryRun ? 'dry-run: skipped log.md append' : 'appended lint entry to log.md',
      counts: {
        brokenLinkTotal: report.brokenLinkTotal,
        brokenLinkTargets: report.brokenLinks.length,
        orphanSources: report.orphanSources.length,
        stubTopics: report.stubTopics.length,
        duplicateTopics: report.duplicateTopics.length,
        dryRun: ctx.dryRun ? 1 : 0,
      },
    };
    // Full lists ride the event stream, not the vault: Phase A reports, it
    // does not delete or merge. Capped so one run cannot balloon the job log.
    yield {
      type: 'data',
      key: 'lint-report',
      value: {
        generatedAt: ctx.generatedAt,
        truncatedAt: MAX_REPORT_ITEMS,
        brokenLinks: report.brokenLinks.slice(0, MAX_REPORT_ITEMS),
        orphanSources: report.orphanSources.slice(0, MAX_REPORT_ITEMS),
        stubTopics: report.stubTopics.slice(0, MAX_REPORT_ITEMS),
        duplicateTopics: report.duplicateTopics.slice(0, MAX_REPORT_ITEMS),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// commit-lint
// ---------------------------------------------------------------------------

/** Everything a lint run can touch — and nothing it doesn't. CLAUDE.md is
 *  deliberately absent: lint never writes it, and staging it would sweep
 *  unrelated in-progress operator edits into a `lint:` commit. Filtered to
 *  what exists before staging — `git add` fails outright on a missing path. */
export const LINT_PATHSPECS = [
  'wiki/',
  'index.md',
  'registry.json',
  'graph.json',
  'log.md',
];

export const commitLint = (git: GitOps, vault: VaultFs): Phase<LintCtx> => ({
  name: 'commit-lint',
  async *run(ctx) {
    if (ctx.dryRun) {
      yield {
        type: 'agent_activity',
        agent: 'commit-lint',
        action: 'noop',
        detail: 'dry-run: skipped git commit',
      };
      return;
    }
    const log = writeLog(ctx);
    if (log.written.length === 0) {
      yield {
        type: 'agent_activity',
        agent: 'commit-lint',
        action: 'noop',
        detail: 'no vault writes this run',
      };
      return;
    }

    const pathspecs: string[] = [];
    for (const spec of LINT_PATHSPECS) {
      if (await vault.exists(spec.endsWith('/') ? spec.slice(0, -1) : spec)) pathspecs.push(spec);
    }
    const message =
      `lint: ${ctx.stats.citedByUpdated ?? 0} cited_by, ` +
      `${ctx.stats.membersReranked ?? 0} topic reranks, ` +
      `${log.written.length} files`;
    const result = await git.commit(message, pathspecs);
    yield {
      type: 'agent_activity',
      agent: 'commit-lint',
      action: result.committed ? 'committed' : 'noop',
      detail: result.committed ? `${result.sha?.slice(0, 7)} — ${message}` : 'no changes to commit',
    };
  },
});

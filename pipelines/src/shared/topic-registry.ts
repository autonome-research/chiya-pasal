/**
 * Topic registry: a deterministic, machine-readable view of the vault's topic
 * vocabulary.
 *
 * The vault's topic namespace is FLAT (`wiki/topics/<slug>.md`) with soft
 * `clusters: [...]` frontmatter as the only grouping signal — never directory
 * hierarchy. Nothing in the pipeline previously enumerated that namespace, so
 * the reviewer assigned topics blind and 57% of sources landed on the
 * `uncategorized` sentinel. This module is the enumeration: one scan produces
 * (a) a human index page, (b) a JSON graph for the visualization tool, and
 * (c) a char-budgeted vocabulary block for agent prompts.
 *
 * Scanning is pure and I/O-cheap by construction:
 *   - topic pages are read whole (2.6k files, small)
 *   - member source pages are read HEAD-ONLY (first 1 KiB) since all we want
 *     is `cited_by:` from their frontmatter, and there are ~22k of them
 *   - every source is read at most once per scan, even when many topics
 *     share it
 *
 * `generatedAt` is caller-supplied rather than read from the clock so callers
 * can render byte-identical output across a run (and so tests are stable).
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync } from 'fs';
import { join } from 'path';

export interface TopicRecord {
  /** Filename without `.md`. */
  slug: string;
  /** H1 text when present, otherwise a title-cased slug. */
  title: string;
  /** First prose line of the body under the H1, if any. */
  oneLiner: string | null;
  /** `clusters:` frontmatter; `[]` when absent. Soft metadata, not taxonomy. */
  clusters: string[];
  /** Distinct `wiki/sources/*` wikilinks in the body. */
  memberCount: number;
  /** Sum of members' `cited_by:` frontmatter; 0 where absent. */
  citedByTotal: number;
  /** `updated:` frontmatter, verbatim. */
  updated: string | null;
}

export interface TopicRegistry {
  /** Sorted by slug. */
  topics: TopicRecord[];
  /** Keys inserted in alphabetical order so object iteration is stable. */
  clusters: Record<string, { topicCount: number }>;
  generatedAt: string;
}

const TOPICS_DIR = join('wiki', 'topics');
const SOURCES_DIR = join('wiki', 'sources');

/**
 * Frontmatter head we read from a source page. A read that stops short of
 * `cited_by:` silently scores the topic 0, so this is sized with headroom
 * rather than to fit. The longest frontmatter across the 21.9k live source
 * pages is 886 bytes and nothing bounds `url:` or `title:`, so a maximal page
 * already lands within ~100 bytes of a 1 KiB budget. Still a single
 * page-sized read per source, so scan cost is unchanged.
 */
const SOURCE_HEAD_BYTES = 4096;

// ---- parsing (pure) -------------------------------------------------------

export interface Frontmatter {
  /** Raw `key: value` scalars, first occurrence wins. */
  scalars: Map<string, string>;
  /** Values of block-list (`- item`) keys. */
  lists: Map<string, string[]>;
  /** Body text after the closing `---`. */
  body: string;
}

/**
 * Line-based frontmatter reader for the constrained schema the vault uses:
 * one-level scalars plus inline (`[a, b]`) or block (`- a`) arrays. A
 * document without a leading `---` is all body — topic pages predating the
 * catalog model have no frontmatter at all.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();

  if (!text.startsWith('---\n')) return { scalars, lists, body: text };
  const closeIdx = text.indexOf('\n---', 4);
  if (closeIdx < 0) return { scalars, lists, body: text };

  const fmBlock = text.slice(4, closeIdx);
  let body = text.slice(closeIdx + 4);
  if (body.startsWith('\n')) body = body.slice(1);

  let currentListKey: string | null = null;
  for (const line of fmBlock.split('\n')) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      const arr = lists.get(currentListKey) ?? [];
      arr.push(unquote(listItem[1]!));
      lists.set(currentListKey, arr);
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) {
      currentListKey = null;
      continue;
    }
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (value === '') {
      // `key:` followed by `- item` lines.
      currentListKey = key;
      if (!lists.has(key)) lists.set(key, []);
      continue;
    }
    currentListKey = null;
    if (!scalars.has(key)) scalars.set(key, value);
  }

  return { scalars, lists, body };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Read a frontmatter key as a string list. Accepts the inline form the page
 * templates emit (`clusters: [a, b]`), the block form, and a bare scalar
 * (`clusters: physics`) that a hand edit might leave behind.
 */
export function readFrontmatterList(fm: Frontmatter, key: string): string[] {
  const scalar = fm.scalars.get(key);
  if (scalar !== undefined) {
    const trimmed = scalar.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      if (inner === '') return [];
      return inner
        .split(',')
        .map((s) => unquote(s))
        .filter((s) => s.length > 0);
    }
    const single = unquote(trimmed);
    return single.length > 0 ? [single] : [];
  }
  return (fm.lists.get(key) ?? []).filter((s) => s.length > 0);
}

// `[[wiki/sources/<name>]]` or `[[wiki/sources/<name>|label]]`, anywhere in
// the body. Member lists live under `## Member sources`, but legacy pages used
// `## Sources` or bare inline links, so section-scoping would lose members.
const SOURCE_WIKILINK_RE = /\[\[\s*wiki\/sources\/([^\]|#]+?)\s*(?:\|[^\]]*)?\]\]/g;

/** Distinct member source filenames (no `wiki/sources/` prefix, no `.md`). */
export function memberSourceNames(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  SOURCE_WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SOURCE_WIKILINK_RE.exec(body)) !== null) {
    let name = m[1]!.trim();
    if (name.endsWith('.md')) name = name.slice(0, -3);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * First prose line of the body: skips blank lines and the H1, then takes the
 * first line that reads as a sentence. Structural lines (headings, list items,
 * tables, quotes, `_None yet._` placeholders, wikilink-only lines) are not
 * prose and yield null — a wrong one-liner is worse than none, since the
 * reviewer sees these as topic definitions.
 */
export function firstProseLine(body: string): string | null {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i < lines.length && /^#\s+/.test(lines[i]!)) i++;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i >= lines.length) return null;

  const line = lines[i]!.trim();
  if (line === '') return null;
  if (/^[#>|*_=-]/.test(line)) return null;
  if (line.startsWith('[[')) return null;
  return line;
}

/** Parse one topic page into a record. Pure — `citedByTotal` is filled later. */
export function parseTopicPage(slug: string, text: string): { record: TopicRecord; members: string[] } {
  const fm = splitFrontmatter(text);
  const members = memberSourceNames(fm.body);

  const h1 = /^#\s+(.+)$/m.exec(fm.body);
  const title = h1 ? h1[1]!.trim() : slugToTitle(slug);

  return {
    record: {
      slug,
      title,
      oneLiner: firstProseLine(fm.body),
      clusters: readFrontmatterList(fm, 'clusters'),
      memberCount: members.length,
      citedByTotal: 0,
      updated: fm.scalars.get('updated') ? unquote(fm.scalars.get('updated')!) : null,
    },
    members,
  };
}

// ---- scanning (I/O) -------------------------------------------------------

/**
 * Read only the first bytes of a file. Source pages carry a long summary body
 * we never look at; whole-file reads across ~22k of them dominate scan time.
 */
function readHead(path: string, bytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function citedByOf(vaultDir: string, sourceName: string): number {
  const head = readHead(join(vaultDir, SOURCES_DIR, `${sourceName}.md`), SOURCE_HEAD_BYTES);
  if (head === null) return 0;
  const m = /^cited_by:\s*(.+)$/m.exec(head);
  if (!m) return 0;
  const n = Number.parseInt(unquote(m[1]!), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Scan `<vaultDir>/wiki/topics/*.md` into a registry.
 *
 * Only the flat namespace is scanned. Legacy empty domain directories still
 * exist under `wiki/topics/`; recursing into them would reintroduce slug
 * ambiguity (two files, one slug) that the flattening migration removed.
 * Files starting with `_` are generated artifacts (the registry page itself)
 * and are skipped so a scan never ingests its own output.
 */
export function scanTopicRegistry(vaultDir: string, generatedAt: string): TopicRegistry {
  const dir = join(vaultDir, TOPICS_DIR);

  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch {
    // Missing topics dir is a legitimate state for a fresh vault.
    return { topics: [], clusters: {}, generatedAt };
  }
  entries.sort();

  const records: TopicRecord[] = [];
  const memberLists: string[][] = [];
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseTopicPage(name.slice(0, -3), text);
    records.push(parsed.record);
    memberLists.push(parsed.members);
  }

  // One read per distinct source, shared across every topic that lists it.
  const citedByCache = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    let total = 0;
    for (const member of memberLists[i]!) {
      let n = citedByCache.get(member);
      if (n === undefined) {
        n = citedByOf(vaultDir, member);
        citedByCache.set(member, n);
      }
      total += n;
    }
    records[i]!.citedByTotal = total;
  }

  return { topics: records, clusters: clusterCounts(records), generatedAt };
}

/** Cluster → topic count, keys inserted alphabetically for stable iteration. */
function clusterCounts(records: TopicRecord[]): Record<string, { topicCount: number }> {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const c of new Set(r.clusters)) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  const out: Record<string, { topicCount: number }> = {};
  for (const name of [...counts.keys()].sort()) {
    out[name] = { topicCount: counts.get(name)! };
  }
  return out;
}

// ---- ordering helpers -----------------------------------------------------

function byMemberCountDesc(a: TopicRecord, b: TopicRecord): number {
  if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
  if (b.citedByTotal !== a.citedByTotal) return b.citedByTotal - a.citedByTotal;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Clusters ordered by topicCount desc, name asc. */
export function orderedClusterNames(reg: TopicRegistry): string[] {
  return Object.keys(reg.clusters).sort((a, b) => {
    const ca = reg.clusters[a]!.topicCount;
    const cb = reg.clusters[b]!.topicCount;
    if (cb !== ca) return cb - ca;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function topicsInCluster(reg: TopicRegistry, cluster: string): TopicRecord[] {
  return reg.topics.filter((t) => t.clusters.includes(cluster)).sort(byMemberCountDesc);
}

function unclusteredTopics(reg: TopicRegistry): TopicRecord[] {
  return reg.topics.filter((t) => t.clusters.length === 0).sort(byMemberCountDesc);
}

// ---- rendering ------------------------------------------------------------

/** How many unclustered topics the human page lists before eliding. */
const UNCLUSTERED_PREVIEW = 50;

/**
 * The human index page (`wiki/topics/_registry.md`). Regenerated wholesale on
 * every run, so it carries a do-not-hand-edit banner: any manual edit is lost
 * on the next scan, and cluster assignment belongs in the topic page's own
 * frontmatter where the scan can see it.
 */
export function renderRegistryMarkdown(reg: TopicRegistry): string {
  const clusterNames = orderedClusterNames(reg);
  const unclustered = unclusteredTopics(reg);
  const clusteredCount = reg.topics.length - unclustered.length;
  const memberTotal = reg.topics.reduce((s, t) => s + t.memberCount, 0);
  const citedByTotal = reg.topics.reduce((s, t) => s + t.citedByTotal, 0);

  const out: string[] = [
    '---',
    'type: registry',
    'status: generated',
    `generated: ${reg.generatedAt}`,
    `topics: ${reg.topics.length}`,
    `clusters: ${clusterNames.length}`,
    '---',
    '',
    '# Topic registry',
    '',
    'Generated index of every topic page in this vault. **Do not hand-edit** — it is',
    'rewritten from scratch on every registry run. To change a topic\'s clusters, edit',
    'the `clusters:` frontmatter on the topic page itself; the next run picks it up.',
    '',
    'Clusters are soft, overlapping metadata — a topic may belong to several, or to',
    'none. They are not a directory hierarchy and never will be.',
    '',
    '## Clusters',
    '',
  ];

  if (clusterNames.length === 0) {
    out.push('_No clusters assigned yet._', '');
  } else {
    for (const name of clusterNames) {
      const topics = topicsInCluster(reg, name);
      out.push(`### ${name} (${topics.length})`, '');
      for (const t of topics) {
        out.push(`- [[wiki/topics/${t.slug}]] — ${t.memberCount} sources${citedSuffix(t)}`);
      }
      out.push('');
    }
  }

  out.push('## Unclustered topics', '');
  if (unclustered.length === 0) {
    out.push('_None — every topic carries at least one cluster._', '');
  } else {
    const shown = unclustered.slice(0, UNCLUSTERED_PREVIEW);
    out.push(
      `${unclustered.length} topics have no cluster assigned. ` +
        (unclustered.length > shown.length
          ? `Showing the top ${shown.length} by member count; the full list is in \`registry.json\`.`
          : 'All are listed below.'),
      '',
    );
    for (const t of shown) {
      out.push(`- [[wiki/topics/${t.slug}]] — ${t.memberCount} sources${citedSuffix(t)}`);
    }
    out.push('');
  }

  out.push(
    '## Stats',
    '',
    `- Topics: ${reg.topics.length}`,
    `- Clustered: ${clusteredCount}`,
    `- Unclustered: ${unclustered.length}`,
    `- Clusters: ${clusterNames.length}`,
    `- Member links: ${memberTotal}`,
    `- Citations into members: ${citedByTotal}`,
    `- Generated: ${reg.generatedAt}`,
    '',
  );

  return out.join('\n');
}

function citedSuffix(t: TopicRecord): string {
  return t.citedByTotal > 0 ? `, ${t.citedByTotal} citations` : '';
}

/**
 * Machine-readable registry for the vault root (`registry.json`) and the
 * future visualization tool. Arrays rather than maps everywhere so ordering is
 * part of the contract instead of an accident of key insertion: clusters by
 * topicCount desc, topics by slug asc.
 */
export function renderRegistryJson(reg: TopicRegistry): string {
  const unclustered = unclusteredTopics(reg);
  const doc = {
    generatedAt: reg.generatedAt,
    stats: {
      topicCount: reg.topics.length,
      clusterCount: Object.keys(reg.clusters).length,
      clusteredTopicCount: reg.topics.length - unclustered.length,
      unclusteredTopicCount: unclustered.length,
      memberTotal: reg.topics.reduce((s, t) => s + t.memberCount, 0),
      citedByTotal: reg.topics.reduce((s, t) => s + t.citedByTotal, 0),
    },
    clusters: orderedClusterNames(reg).map((name) => ({
      name,
      topicCount: reg.clusters[name]!.topicCount,
    })),
    topics: reg.topics.map((t) => ({
      slug: t.slug,
      title: t.title,
      oneLiner: t.oneLiner,
      clusters: t.clusters,
      memberCount: t.memberCount,
      citedByTotal: t.citedByTotal,
      updated: t.updated,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---- agent-facing vocabulary ----------------------------------------------

const UNCLUSTERED_GROUP = '(unclustered)';

/**
 * Cluster-grouped slug inventory for agent prompts.
 *
 * The reviewer has to assign topics against a vocabulary it can actually see;
 * without this it invents slugs and the apply phase files them under
 * `uncategorized`. Grouping by cluster gives the model the vault's shape in
 * far fewer tokens than a flat 2.6k-slug dump, and importance ordering
 * (largest clusters first, biggest topics within) means a truncated block
 * still carries the load-bearing part of the vocabulary.
 *
 * Budget allocation is breadth-first, not greedy: every group gets a header
 * and one slug before any group gets a second. A greedy fill would hand the
 * whole budget to `ai-ml` (563 topics in the live vault) and the reviewer
 * would never learn that `physics` or the unclustered pile exist — which is
 * exactly the blindness this function exists to fix. Leftover budget is then
 * distributed round-robin in importance order, largest group first.
 *
 * The returned string is guaranteed `<= opts.maxChars`; each group carries a
 * `(+N more)` tail for whatever it dropped.
 */
export function vocabularyForPrompt(reg: TopicRegistry, opts: { maxChars: number }): string {
  if (opts.maxChars <= 0) return '';

  // The unclustered pile is a group like any other and is ranked by its own
  // size — in the live vault it is the LARGEST group (1444 of 2602 topics), so
  // burying it last would hide over half the vocabulary from the reviewer and
  // invite duplicate topics. Real clusters win ties so ordinary output still
  // reads cluster-first.
  const groups: Array<{ name: string; topics: TopicRecord[]; pseudo: boolean }> =
    orderedClusterNames(reg)
      .map((name) => ({ name, topics: topicsInCluster(reg, name), pseudo: false }))
      .filter((g) => g.topics.length > 0);
  const loose = unclusteredTopics(reg);
  if (loose.length > 0) groups.push({ name: UNCLUSTERED_GROUP, topics: loose, pseudo: true });
  groups.sort((a, b) => {
    if (b.topics.length !== a.topics.length) return b.topics.length - a.topics.length;
    if (a.pseudo !== b.pseudo) return a.pseudo ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // Elision tails are charged for up front on every partial group, so growing
  // a group can only ever shrink its tail — the budget can never be overrun by
  // a suffix appended after the fact.
  const tailLen = (remaining: number): number =>
    remaining > 0 ? ` (+${remaining} more)`.length : 0;

  // Pass 1 — seed: header plus one slug per group, in importance order. Stops
  // at the first group that does not fit, so the surviving group set is always
  // a prefix of the importance ranking.
  const drafts: Array<{ topics: TopicRecord[]; header: string; shown: number }> = [];
  let used = 0;
  for (const group of groups) {
    const header = `${group.name} (${group.topics.length}): `;
    const sep = drafts.length > 0 ? 1 : 0; // the joining '\n'
    const cost =
      sep + header.length + group.topics[0]!.slug.length + tailLen(group.topics.length - 1);
    if (used + cost > opts.maxChars) break;
    drafts.push({ topics: group.topics, header, shown: 1 });
    used += cost;
  }
  if (drafts.length === 0) return '';

  // Pass 2 — grow: one more slug per group per round until nothing fits.
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of drafts) {
      if (d.shown >= d.topics.length) continue;
      const cost =
        2 + // ', '
        d.topics[d.shown]!.slug.length +
        tailLen(d.topics.length - d.shown - 1) -
        tailLen(d.topics.length - d.shown);
      if (used + cost > opts.maxChars) continue;
      d.shown++;
      used += cost;
      grew = true;
    }
  }

  return drafts
    .map((d) => {
      const slugs = d.topics
        .slice(0, d.shown)
        .map((t) => t.slug)
        .join(', ');
      const left = d.topics.length - d.shown;
      return d.header + slugs + (left > 0 ? ` (+${left} more)` : '');
    })
    .join('\n');
}

// ---- lookup ---------------------------------------------------------------

// Slug sets are derived, not stored, so the TopicRegistry stays a plain
// serializable value. Cached per registry object: isKnownSlug is called once
// per proposed topic, and the reviewer proposes many per article.
const slugSetCache = new WeakMap<TopicRegistry, Set<string>>();

function slugSet(reg: TopicRegistry): Set<string> {
  let set = slugSetCache.get(reg);
  if (!set) {
    set = new Set(reg.topics.map((t) => t.slug));
    slugSetCache.set(reg, set);
  }
  return set;
}

export function isKnownSlug(reg: TopicRegistry, slug: string): boolean {
  return slugSet(reg).has(normalizeSlug(slug));
}

/** Lowercase, non-alphanumerics to single hyphens, trimmed. */
function normalizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length]!;
}

/**
 * Floor for `nearestSlugs`. Unrelated slugs of similar length still score a
 * nonzero edit similarity (~0.1), so without a floor every lookup would return
 * a full list of confident-looking garbage. Calibrated so plural/typo drift
 * (~0.55) and token reorderings (~0.3) survive while unrelated pairs do not.
 */
const MIN_SIMILARITY = 0.25;

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Fuzzy-correction candidates for a slug the registry doesn't know.
 *
 * Two signals, averaged: normalized edit distance (catches typos and
 * singular/plural drift — `agent-memories` → `agent-memory`) and token Jaccard
 * (catches reordering and qualifiers — `memory-for-agents` → `agent-memory`,
 * which edit distance alone scores near zero). Candidates below MIN_SIMILARITY
 * are dropped rather than padded out to `n`: an empty list is a usable answer
 * ("this really is a new topic"), a list of unrelated slugs is an invitation
 * to file the source in the wrong place.
 */
export function nearestSlugs(reg: TopicRegistry, slug: string, n: number): string[] {
  if (n <= 0) return [];
  const target = normalizeSlug(slug);
  if (target.length === 0) return [];
  const targetTokens = target.split('-').filter((t) => t.length > 0);

  const scored: Array<{ slug: string; score: number }> = [];
  for (const t of reg.topics) {
    const candidate = normalizeSlug(t.slug);
    const maxLen = Math.max(target.length, candidate.length);
    const editSim = maxLen === 0 ? 0 : 1 - levenshtein(target, candidate) / maxLen;
    const overlap = tokenOverlap(targetTokens, candidate.split('-').filter((s) => s.length > 0));
    const score = (editSim + overlap) / 2;
    if (score < MIN_SIMILARITY) continue;
    scored.push({ slug: t.slug, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return scored.slice(0, n).map((s) => s.slug);
}

/**
 * Pure-functional page formatters for entity pages
 * (wiki/entities/<slug>.md) — the third page kind in the catalog model
 * alongside sources and topics.
 *
 * Entity pages are backlink hubs, not prose: a person/organization/product
 * page exists so the graph can answer "what has this library collected about
 * X". The reviewer already recommends entities per article; until now apply
 * discarded every recommendation whose page did not already exist, so the
 * namespace could never grow.
 *
 * Frontmatter follows page-templates.ts conventions (single-level scalars,
 * one-line inline arrays) so the same line-based mutators work here.
 */

export type EntityKind = 'person' | 'organization' | 'product' | 'tool' | 'other';

const ENTITY_KINDS: ReadonlySet<string> = new Set([
  'person',
  'organization',
  'product',
  'tool',
  'other',
]);

/** Narrow an agent-supplied kind to the closed set; unknown → null (the
 *  `kind:` line is then omitted rather than guessed). */
export function asEntityKind(raw: unknown): EntityKind | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  if (k === 'org' || k === 'company' || k === 'lab') return 'organization';
  return ENTITY_KINDS.has(k) ? (k as EntityKind) : null;
}

/**
 * Shared sanitizer for agent-proposed page slugs (entities here, topics via
 * the reviewer's output sanitizer). Slugs become filesystem paths, so this is
 * a safety boundary as much as a style one: anything that is not
 * `[a-z0-9-]` collapses to a single hyphen, which makes traversal
 * (`../../etc`) and spaces unrepresentable. Returns '' when nothing survives —
 * callers drop those entries.
 */
export function sanitizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export interface EntityMention {
  /** Source page filename without wiki/sources/ and without .md. */
  filename: string;
  title: string;
  collected: Date;
}

export interface EntityPageInput {
  slug: string;
  /** Display name; falls back to a title-cased slug. */
  name?: string | null;
  kind?: EntityKind | null;
  created: Date;
  updated?: Date;
  mentionedIn: EntityMention[];
}

export const MENTIONED_IN_HEADING = '## Mentioned in';

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  return ymd(new Date());
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

function mentionLine(m: EntityMention): string {
  return `- [[wiki/sources/${m.filename}]] — ${m.title} (${ymd(m.collected)})`;
}

export function formatEntityPage(input: EntityPageInput): string {
  const created = ymd(input.created);
  const updated = ymd(input.updated ?? input.created);
  const name = input.name?.trim() ? input.name.trim() : slugToTitle(input.slug);

  const fmLines: string[] = ['---', 'type: entity', 'status: active'];
  if (input.kind) fmLines.push(`kind: ${input.kind}`);
  fmLines.push(
    `created: ${created}`,
    `updated: ${updated}`,
    `mentions: ${input.mentionedIn.length}`,
    '---',
  );

  const body: string[] = ['', `# ${name}`, '', MENTIONED_IN_HEADING, ''];
  if (input.mentionedIn.length === 0) {
    body.push('_None yet._');
  } else {
    const sorted = [...input.mentionedIn].sort(
      (a, b) => b.collected.getTime() - a.collected.getTime(),
    );
    for (const m of sorted) body.push(mentionLine(m));
  }
  body.push('');

  return fmLines.join('\n') + '\n' + body.join('\n');
}

/**
 * Idempotent backlink append. Re-applying the same source is a no-op, so a
 * re-run (or a second article that shares a stable id) never duplicates a
 * line. Appends rather than re-sorting the section: legacy entity pages
 * predate this template and may carry hand-written lines a rewrite would
 * silently drop.
 *
 * A page with no `## Mentioned in` section gains one at the end, so the
 * existing (dead) entity pages in the vault adopt the format on first touch.
 */
export function appendMentionedIn(entityPageText: string, mention: EntityMention): string {
  const lineRe = new RegExp(
    `^- \\[\\[wiki/sources/${escapeRegex(mention.filename)}\\]\\]`,
    'm',
  );
  if (lineRe.test(entityPageText)) return entityPageText;

  const lines = entityPageText.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith(MENTIONED_IN_HEADING));

  let newLines: string[];
  if (headerIdx < 0) {
    const trimmedTail = [...lines];
    while (trimmedTail.length > 0 && trimmedTail.at(-1)!.trim() === '') trimmedTail.pop();
    newLines = [...trimmedTail, '', MENTIONED_IN_HEADING, '', mentionLine(mention), ''];
  } else {
    let endIdx = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith('## ')) {
        endIdx = i;
        break;
      }
    }
    const sectionLines = lines.slice(headerIdx + 1, endIdx);
    const entries = sectionLines.filter((l) => l.startsWith('- [[wiki/sources/'));
    entries.push(mentionLine(mention));
    const rebuilt: string[] = [lines[headerIdx]!, '', ...entries];
    if (endIdx < lines.length) rebuilt.push('');
    newLines = [...lines.slice(0, headerIdx), ...rebuilt, ...lines.slice(endIdx)];
  }

  const text = newLines.join('\n');
  return bumpEntityCounters(text, countMentions(text));
}

function countMentions(text: string): number {
  let count = 0;
  let inSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith(MENTIONED_IN_HEADING)) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith('## ')) break;
    if (inSection && line.startsWith('- [[wiki/sources/')) count++;
  }
  return count;
}

/**
 * In-place `mentions:`/`updated:` refresh. Deliberately local rather than
 * reusing page-templates' bumpFrontmatterField: a page without frontmatter
 * (legacy hand-written entity stubs) must stay untouched rather than grow a
 * malformed block.
 */
function bumpEntityCounters(text: string, mentions: number): string {
  if (!text.startsWith('---\n')) return text;
  const closeIdx = text.indexOf('\n---', 4);
  if (closeIdx < 0) return text;
  const fmLines = text.slice(4, closeIdx).split('\n');
  const rest = text.slice(closeIdx);

  let sawMentions = false;
  let sawUpdated = false;
  const bumped = fmLines.map((line) => {
    if (!sawMentions && line.startsWith('mentions:')) {
      sawMentions = true;
      return `mentions: ${mentions}`;
    }
    if (!sawUpdated && line.startsWith('updated:')) {
      sawUpdated = true;
      return `updated: ${todayYmd()}`;
    }
    return line;
  });
  if (!sawMentions) bumped.push(`mentions: ${mentions}`);
  if (!sawUpdated) bumped.push(`updated: ${todayYmd()}`);

  return `---\n${bumped.join('\n')}${rest}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

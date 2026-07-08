/**
 * Pure-functional page formatters for the chiya-library catalog model.
 *
 * One source page per ingested article (wiki/sources/<stable-id>.md);
 * one topic page per routing node (wiki/topics/<slug>.md). The frontmatter
 * shape is deliberately constrained — single-level scalars and one-line
 * inline arrays — so a tiny line-based parser is enough to mutate it.
 */

import { createHash } from 'crypto';

export type StableId =
  | { kind: 'arxiv'; id: string }
  | { kind: 'doi'; doi: string }
  | { kind: 'url'; hash: string };

export interface SourcePageInput {
  stableId: StableId;
  url: string;
  arxivId?: string;
  doi?: string;
  sourceName: string | null;
  collected: Date;
  title: string;
  field: string | null;
  topics: string[];
  cites: string[];
  /** Existing source filenames (without wiki/sources/ and .md) related to this source. */
  related?: string[];
  summary: string;
}

export interface TopicPageInput {
  slug: string;
  created: Date;
  updated: Date;
  definition: string;
  members: Array<{ filename: string; title: string; collected: Date }>;
  relatedTopics: Array<{ slug: string; reason: string }>;
  /**
   * Soft cluster memberships preserved across migrations and tracked as the
   * librarian routes new sources. Empty (the default) means the topic isn't
   * scoped to any domain — orthogonal to any rigid taxonomy. Multiple values
   * are explicitly supported: a topic that spans several domains carries all
   * of them. Emitted as a YAML inline array only when non-empty.
   */
  clusters?: string[];
}

// arXiv: any of /abs/ or /pdf/, optional version, optional .pdf, optional query/fragment.
// Modern id `2605.03823` or old-style `cs.AI/0501001`.
const ARXIV_URL_RE =
  /^(?:https?:\/\/)?(?:www\.|export\.|api\.)?arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}|[a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7,})(?:v\d+)?(?:\.pdf)?(?:[?#].*)?\/?$/i;

const DOI_URL_RE =
  /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+?)\/?$/;

export function stableIdForUrl(url: string | null | undefined): StableId | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  const arxivMatch = ARXIV_URL_RE.exec(trimmed);
  if (arxivMatch && arxivMatch[1]) {
    return { kind: 'arxiv', id: arxivMatch[1] };
  }

  const doiMatch = DOI_URL_RE.exec(trimmed);
  if (doiMatch && doiMatch[1]) {
    return { kind: 'doi', doi: doiMatch[1].toLowerCase() };
  }

  // Anything that's not a parseable absolute URL is invalid.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!parsed.protocol || !parsed.hostname) return null;

  const normalized = `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return { kind: 'url', hash };
}

export function stableIdToFilename(id: StableId): string {
  switch (id.kind) {
    case 'arxiv':
      return `arxiv-${id.id.toLowerCase().replace(/[./]/g, '-')}`;
    case 'doi':
      return `doi-${id.doi.toLowerCase().replace(/[./]/g, '-')}`;
    case 'url':
      return `url-${id.hash}`;
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  return ymd(new Date());
}

// JSON.stringify produces `"...with \"escapes\""` which is a valid YAML
// double-quoted scalar for our purposes (no control chars expected in titles).
function yamlString(s: string): string {
  return JSON.stringify(s);
}

function yamlInlineArray(items: string[]): string {
  return `[${items.join(', ')}]`;
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Demote H2 headings to H3. The rich summaries from the shared pipeline
 * carry their own `## Overview` / `## Findings` sections; source pages
 * embed them under a `## Summary` heading, so the summary's sections must
 * sit one level deeper to keep the page outline coherent in Obsidian.
 * No-op for prose summaries (legacy rows) and deeper headings.
 */
export function demoteH2(markdown: string): string {
  return markdown.replace(/^## (?!#)/gm, '### ');
}

export function formatSourcePage(input: SourcePageInput): string {
  const collectedYmd = ymd(input.collected);
  const sourceLabel = input.sourceName ?? 'unknown';
  const fieldLabel = input.field ?? 'unknown';

  const fmLines: string[] = ['---', 'type: source', 'status: ingested', `url: ${input.url}`];
  if (input.stableId.kind === 'arxiv') {
    fmLines.push(`arxiv_id: ${input.arxivId ?? input.stableId.id}`);
  }
  if (input.stableId.kind === 'doi') {
    fmLines.push(`doi: ${input.doi ?? input.stableId.doi}`);
  }
  const related = input.related ?? [];
  fmLines.push(
    `source_name: ${sourceLabel}`,
    `collected: ${collectedYmd}`,
    `title: ${yamlString(input.title)}`,
    `field: ${fieldLabel}`,
    `topics: ${yamlInlineArray(input.topics)}`,
    `cites: ${yamlInlineArray(input.cites)}`,
    `related: ${yamlInlineArray(related)}`,
    '---',
  );

  const body: string[] = [
    '',
    `# ${input.title}`,
    '',
    `> [${sourceLabel} (${collectedYmd})](${input.url}) — collected by chiya-librarian on ${collectedYmd}.`,
    '',
    '## Summary',
    '',
    demoteH2(input.summary),
    '',
    '## Topics',
    '',
  ];
  if (input.topics.length === 0) {
    body.push('_None yet._');
  } else {
    for (const t of input.topics) body.push(`- [[wiki/topics/${t}]]`);
  }
  body.push('', '## Cited references in this library', '');
  if (input.cites.length === 0) {
    body.push('_None resolved against the current library._');
  } else {
    for (const c of input.cites) body.push(`- [[wiki/sources/${c}]]`);
  }
  body.push('', '## Related sources', '');
  if (related.length === 0) {
    body.push('_None._');
  } else {
    for (const r of related) body.push(`- [[wiki/sources/${r}]]`);
  }
  body.push('', '## Cited by', '');

  return fmLines.join('\n') + '\n' + body.join('\n');
}

export function formatTopicPage(input: TopicPageInput): string {
  const fmLines: string[] = [
    '---',
    'type: topic',
    'status: active',
    `created: ${ymd(input.created)}`,
    `updated: ${ymd(input.updated)}`,
    `sources: ${input.members.length}`,
  ];
  if (input.clusters && input.clusters.length > 0) {
    fmLines.push(`clusters: ${yamlInlineArray(input.clusters)}`);
  }
  fmLines.push(
    `related_topics: ${yamlInlineArray(input.relatedTopics.map((r) => r.slug))}`,
    '---',
  );

  const body: string[] = [
    '',
    `# ${slugToTitle(input.slug)}`,
    '',
    input.definition,
    '',
    '## Member sources',
    '',
  ];
  if (input.members.length === 0) {
    body.push('_None yet._');
  } else {
    const sorted = [...input.members].sort(
      (a, b) => b.collected.getTime() - a.collected.getTime(),
    );
    for (const m of sorted) {
      body.push(`- [[wiki/sources/${m.filename}]] — ${m.title} (${ymd(m.collected)})`);
    }
  }
  if (input.relatedTopics.length > 0) {
    body.push('', '## Related topics', '');
    for (const r of input.relatedTopics) {
      body.push(`- [[wiki/topics/${r.slug}]] — ${r.reason}`);
    }
  }
  body.push('');

  return fmLines.join('\n') + '\n' + body.join('\n');
}

interface FrontmatterSplit {
  fmLines: string[]; // lines between the two `---` markers, exclusive
  body: string;      // everything after the closing `---\n`
  bodyLeadingNewline: boolean; // whether the original had a newline immediately after closing `---`
}

function splitFrontmatter(text: string): FrontmatterSplit | null {
  if (!text.startsWith('---\n')) return null;
  const rest = text.slice(4);
  const closeIdx = rest.indexOf('\n---');
  if (closeIdx < 0) return null;
  const fmBlock = rest.slice(0, closeIdx);
  const after = rest.slice(closeIdx + 4); // skip "\n---"
  // After the closing ---, we expect a single \n then the body.
  const bodyLeadingNewline = after.startsWith('\n');
  const body = bodyLeadingNewline ? after.slice(1) : after;
  return { fmLines: fmBlock.split('\n'), body, bodyLeadingNewline };
}

function joinFrontmatter(split: FrontmatterSplit): string {
  const fm = `---\n${split.fmLines.join('\n')}\n---`;
  return fm + (split.bodyLeadingNewline ? '\n' : '') + split.body;
}

export function bumpFrontmatterField(
  text: string,
  key: string,
  value: number | string,
): string {
  const split = splitFrontmatter(text);
  if (!split) return text;
  const rendered = typeof value === 'number' ? String(value) : value;
  const prefix = `${key}:`;
  let found = false;
  const newFm = split.fmLines.map((line) => {
    if (!found && line.startsWith(prefix)) {
      found = true;
      return `${key}: ${rendered}`;
    }
    return line;
  });
  if (!found) newFm.push(`${key}: ${rendered}`);
  return joinFrontmatter({ ...split, fmLines: newFm });
}

// Parse `key: [a, b, c]` style inline arrays. Returns null if the key isn't an
// inline array (or isn't present). Used by appendMemberSource to bump `sources:`
// based on the actual list count.
function readInlineArray(fmLines: string[], key: string): string[] | null {
  const prefix = `${key}:`;
  for (const line of fmLines) {
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length).trim();
      const m = /^\[(.*)\]$/.exec(rest);
      if (!m) return null;
      const inner = m[1]!.trim();
      if (inner === '') return [];
      return inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }
  return null;
}

export function appendMemberSource(
  topicPageText: string,
  member: { filename: string; title: string; collected: Date },
): string {
  const memberLineRe = new RegExp(
    `^- \\[\\[wiki/sources/${escapeRegex(member.filename)}\\]\\]`,
    'm',
  );
  if (memberLineRe.test(topicPageText)) return topicPageText;

  const split = splitFrontmatter(topicPageText);
  if (!split) return topicPageText;

  // Replace `_None yet._` block, or insert into the existing list sorted by
  // collected date desc. Lines look like:
  //   - [[wiki/sources/{filename}]] — {title} ({YYYY-MM-DD})
  const existing = parseMemberLines(split.body);
  existing.push({ ...member });
  existing.sort((a, b) => b.collected.getTime() - a.collected.getTime());

  const newBody = rewriteMemberSection(split.body, existing);
  let newText = joinFrontmatter({ ...split, body: newBody });
  newText = bumpFrontmatterField(newText, 'sources', existing.length);
  newText = bumpFrontmatterField(newText, 'updated', todayYmd());
  return newText;
}

interface ParsedMember {
  filename: string;
  title: string;
  collected: Date;
}

const MEMBER_LINE_RE =
  /^- \[\[wiki\/sources\/([^\]]+)\]\] — (.+) \((\d{4}-\d{2}-\d{2})\)$/;

function parseMemberLines(body: string): ParsedMember[] {
  const lines = body.split('\n');
  const out: ParsedMember[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith('## Member sources')) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith('## ')) break;
    if (!inSection) continue;
    const m = MEMBER_LINE_RE.exec(line);
    if (m) {
      out.push({
        filename: m[1]!,
        title: m[2]!,
        collected: new Date(`${m[3]!}T00:00:00Z`),
      });
    }
  }
  return out;
}

function rewriteMemberSection(body: string, members: ParsedMember[]): string {
  const lines = body.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith('## Member sources'));
  if (headerIdx < 0) return body;

  // Find the end of the section: next `## ` heading, or end of file.
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      endIdx = i;
      break;
    }
  }

  const newLines: string[] = [lines[headerIdx]!, ''];
  if (members.length === 0) {
    newLines.push('_None yet._');
  } else {
    for (const m of members) {
      newLines.push(`- [[wiki/sources/${m.filename}]] — ${m.title} (${ymd(m.collected)})`);
    }
  }
  // Preserve a single blank line before the next section (if any).
  if (endIdx < lines.length) newLines.push('');

  return [...lines.slice(0, headerIdx), ...newLines, ...lines.slice(endIdx)].join('\n');
}

export function appendCitedBy(
  sourcePageText: string,
  citing: { filename: string; title: string },
): string {
  const lineRe = new RegExp(
    `^- \\[\\[wiki/sources/${escapeRegex(citing.filename)}\\]\\]`,
    'm',
  );
  if (lineRe.test(sourcePageText)) return sourcePageText;

  const lines = sourcePageText.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith('## Cited by'));
  if (headerIdx < 0) return sourcePageText;

  // Find the end of the section: next `## ` heading or end of file.
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      endIdx = i;
      break;
    }
  }

  // Existing entries between headerIdx+1 and endIdx (skipping blank lines).
  const sectionLines = lines.slice(headerIdx + 1, endIdx);
  const existingEntries = sectionLines.filter((l) => l.startsWith('- [[wiki/sources/'));
  existingEntries.push(`- [[wiki/sources/${citing.filename}]] — ${citing.title}`);

  const rebuilt: string[] = [lines[headerIdx]!, '', ...existingEntries];
  if (endIdx < lines.length) rebuilt.push('');

  const newLines = [...lines.slice(0, headerIdx), ...rebuilt, ...lines.slice(endIdx)];
  return newLines.join('\n');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Re-exported for tests that want to inspect the inline-array reader.
export const _internal = { readInlineArray, splitFrontmatter };

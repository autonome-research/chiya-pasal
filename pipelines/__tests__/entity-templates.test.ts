import { describe, it, expect } from 'vitest';

import {
  appendMentionedIn,
  asEntityKind,
  formatEntityPage,
  sanitizeSlug,
  MENTIONED_IN_HEADING,
} from '../src/phases/entity-templates.js';

const mention = (filename: string, title: string, ymd: string) => ({
  filename,
  title,
  collected: new Date(`${ymd}T00:00:00Z`),
});

describe('sanitizeSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(sanitizeSlug('Anthropic PBC')).toBe('anthropic-pbc');
    expect(sanitizeSlug('  GPT-4  ')).toBe('gpt-4');
  });

  it('makes traversal and separators unrepresentable', () => {
    expect(sanitizeSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeSlug('a/b\\c')).toBe('a-b-c');
  });

  it('returns empty when nothing survives (callers drop the entry)', () => {
    expect(sanitizeSlug('///')).toBe('');
    expect(sanitizeSlug('   ')).toBe('');
  });

  it('caps length without leaving a trailing hyphen', () => {
    const long = sanitizeSlug(`${'a'.repeat(79)} tail`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('asEntityKind', () => {
  it('accepts the closed set and common synonyms', () => {
    expect(asEntityKind('person')).toBe('person');
    expect(asEntityKind('Organization')).toBe('organization');
    expect(asEntityKind('company')).toBe('organization');
    expect(asEntityKind('lab')).toBe('organization');
  });

  it('returns null for anything else so the kind line is omitted', () => {
    expect(asEntityKind('spaceship')).toBeNull();
    expect(asEntityKind(42)).toBeNull();
    expect(asEntityKind(undefined)).toBeNull();
  });
});

describe('formatEntityPage', () => {
  it('renders frontmatter, title, and the backlink section', () => {
    const page = formatEntityPage({
      slug: 'anthropic',
      name: 'Anthropic',
      kind: 'organization',
      created: new Date('2026-08-01T00:00:00Z'),
      mentionedIn: [mention('arxiv-2605-00001', 'A paper', '2026-08-01')],
    });
    expect(page.startsWith('---\ntype: entity\nstatus: active\nkind: organization\n')).toBe(true);
    expect(page).toContain('created: 2026-08-01');
    expect(page).toContain('updated: 2026-08-01');
    expect(page).toContain('mentions: 1');
    expect(page).toContain('# Anthropic');
    expect(page).toContain(MENTIONED_IN_HEADING);
    expect(page).toContain('- [[wiki/sources/arxiv-2605-00001]] — A paper (2026-08-01)');
  });

  it('omits kind when unknown and title-cases the slug without a name', () => {
    const page = formatEntityPage({
      slug: 'yann-lecun',
      created: new Date('2026-08-01T00:00:00Z'),
      mentionedIn: [],
    });
    expect(page).not.toContain('kind:');
    expect(page).toContain('# Yann Lecun');
    expect(page).toContain('mentions: 0');
    expect(page).toContain('_None yet._');
  });

  it('sorts mentions newest first', () => {
    const page = formatEntityPage({
      slug: 'anthropic',
      created: new Date('2026-08-01T00:00:00Z'),
      mentionedIn: [
        mention('old', 'Old paper', '2026-01-01'),
        mention('new', 'New paper', '2026-07-01'),
      ],
    });
    expect(page.indexOf('wiki/sources/new')).toBeLessThan(page.indexOf('wiki/sources/old'));
  });
});

describe('appendMentionedIn', () => {
  const base = formatEntityPage({
    slug: 'anthropic',
    kind: 'organization',
    created: new Date('2026-08-01T00:00:00Z'),
    mentionedIn: [mention('arxiv-2605-00001', 'First paper', '2026-08-01')],
  });

  it('appends a new backlink and bumps the mention count', () => {
    const out = appendMentionedIn(base, mention('arxiv-2605-00002', 'Second paper', '2026-08-02'));
    expect(out).toContain('- [[wiki/sources/arxiv-2605-00001]]');
    expect(out).toContain('- [[wiki/sources/arxiv-2605-00002]] — Second paper (2026-08-02)');
    expect(out).toContain('mentions: 2');
  });

  it('is idempotent: re-mentioning the same source is a no-op', () => {
    const once = appendMentionedIn(base, mention('arxiv-2605-00002', 'Second paper', '2026-08-02'));
    const twice = appendMentionedIn(once, mention('arxiv-2605-00002', 'Second paper', '2026-08-02'));
    expect(twice).toBe(once);
  });

  it('replaces the empty-state marker rather than listing beneath it', () => {
    const empty = formatEntityPage({
      slug: 'anthropic',
      created: new Date('2026-08-01T00:00:00Z'),
      mentionedIn: [],
    });
    const out = appendMentionedIn(empty, mention('arxiv-1', 'Paper', '2026-08-02'));
    expect(out).not.toContain('_None yet._');
    expect(out).toContain('mentions: 1');
  });

  it('adds the section to a legacy page that lacks it, preserving prose', () => {
    const legacy = '---\ntype: entity\n---\n\n# Anthropic\n\nSome hand-written notes.\n';
    const out = appendMentionedIn(legacy, mention('arxiv-1', 'Paper', '2026-08-02'));
    expect(out).toContain('Some hand-written notes.');
    expect(out).toContain(MENTIONED_IN_HEADING);
    expect(out).toContain('- [[wiki/sources/arxiv-1]] — Paper (2026-08-02)');
    expect(out).toContain('mentions: 1');
    expect(appendMentionedIn(out, mention('arxiv-1', 'Paper', '2026-08-02'))).toBe(out);
  });

  it('leaves a frontmatter-less page structurally intact', () => {
    const bare = `# Anthropic\n\n${MENTIONED_IN_HEADING}\n\n`;
    const out = appendMentionedIn(bare, mention('arxiv-1', 'Paper', '2026-08-02'));
    expect(out).toContain('- [[wiki/sources/arxiv-1]] — Paper (2026-08-02)');
    expect(out).not.toContain('mentions:');
  });

  it('keeps trailing sections after the backlink list', () => {
    const withTail = `${base}\n## Notes\n\nkeep me\n`;
    const out = appendMentionedIn(withTail, mention('arxiv-2', 'Paper', '2026-08-02'));
    expect(out).toContain('## Notes');
    expect(out).toContain('keep me');
    expect(out.indexOf('wiki/sources/arxiv-2')).toBeLessThan(out.indexOf('## Notes'));
  });
});

import { describe, it, expect } from 'vitest';
import {
  stableIdForUrl,
  stableIdToFilename,
  formatSourcePage,
  formatTopicPage,
  appendMemberSource,
  appendCitedBy,
  bumpFrontmatterField,
  demoteH2,
  type StableId,
  type SourcePageInput,
  type TopicPageInput,
} from '../src/phases/page-templates.js';

describe('stableIdForUrl', () => {
  it('arxiv abs (no version)', () => {
    expect(stableIdForUrl('https://arxiv.org/abs/2605.03823')).toEqual({
      kind: 'arxiv',
      id: '2605.03823',
    });
  });

  it('arxiv abs with version → strips version', () => {
    expect(stableIdForUrl('https://arxiv.org/abs/2605.03823v1')).toEqual({
      kind: 'arxiv',
      id: '2605.03823',
    });
  });

  it('arxiv abs with version + .pdf', () => {
    expect(stableIdForUrl('https://arxiv.org/abs/2605.03823v2.pdf')).toEqual({
      kind: 'arxiv',
      id: '2605.03823',
    });
  });

  it('arxiv pdf URL (http)', () => {
    expect(stableIdForUrl('http://arxiv.org/pdf/2605.03823')).toEqual({
      kind: 'arxiv',
      id: '2605.03823',
    });
  });

  it('arxiv old-style id', () => {
    expect(stableIdForUrl('https://arxiv.org/abs/cs.AI/0501001')).toEqual({
      kind: 'arxiv',
      id: 'cs.AI/0501001',
    });
  });

  it('DOI URL with mixed case → lowercased', () => {
    expect(stableIdForUrl('https://doi.org/10.1038/S41586-024-12345-6')).toEqual({
      kind: 'doi',
      doi: '10.1038/s41586-024-12345-6',
    });
  });

  it('dx.doi.org → same DOI form', () => {
    expect(stableIdForUrl('https://dx.doi.org/10.1038/s41586-024-12345-6')).toEqual({
      kind: 'doi',
      doi: '10.1038/s41586-024-12345-6',
    });
  });

  it('random URL → url kind with deterministic 12-char hex hash', () => {
    const a = stableIdForUrl('https://example.com/some/random/page');
    const b = stableIdForUrl('https://example.com/some/random/page');
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('url');
    if (a && a.kind === 'url') {
      expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(a).toEqual(b);
  });

  it('different URLs hash differently', () => {
    const a = stableIdForUrl('https://example.com/a');
    const b = stableIdForUrl('https://example.com/b');
    expect(a).not.toEqual(b);
  });

  it('null / empty / invalid → null', () => {
    expect(stableIdForUrl('')).toBeNull();
    expect(stableIdForUrl('   ')).toBeNull();
    expect(stableIdForUrl('not a url at all')).toBeNull();
    expect(stableIdForUrl(null as unknown as string)).toBeNull();
  });
});

describe('stableIdToFilename', () => {
  it('arxiv modern id → arxiv-NNNN-NNNNN', () => {
    const id: StableId = { kind: 'arxiv', id: '2605.03823' };
    expect(stableIdToFilename(id)).toBe('arxiv-2605-03823');
  });

  it('arxiv old-style id → slashes and dots both become dashes, lowercase', () => {
    const id: StableId = { kind: 'arxiv', id: 'cs.AI/0501001' };
    expect(stableIdToFilename(id)).toBe('arxiv-cs-ai-0501001');
  });

  it('doi → doi-... with dots and slashes flattened', () => {
    const id: StableId = { kind: 'doi', doi: '10.1038/s41586-024-12345-6' };
    expect(stableIdToFilename(id)).toBe('doi-10-1038-s41586-024-12345-6');
  });

  it('url → url-{12 hex}', () => {
    const id: StableId = { kind: 'url', hash: 'abcdef012345' };
    expect(stableIdToFilename(id)).toBe('url-abcdef012345');
  });
});

const baseSourceInput = (overrides: Partial<SourcePageInput> = {}): SourcePageInput => ({
  stableId: { kind: 'arxiv', id: '2605.03823' },
  url: 'https://arxiv.org/abs/2605.03823',
  arxivId: '2605.03823',
  sourceName: 'arXiv',
  collected: new Date('2026-05-01T12:00:00Z'),
  title: 'A Study of Things',
  field: 'AI/ML',
  topics: ['bayes-consistency', 'healthcare-ai'],
  cites: ['arxiv-2403-12834'],
  summary: 'This is the first paragraph.\n\nThis is the second paragraph.',
  ...overrides,
});

// Minimal line-based parser for our constrained frontmatter shape.
function parseFrontmatter(text: string): Record<string, string> {
  expect(text.startsWith('---\n')).toBe(true);
  const end = text.indexOf('\n---', 4);
  expect(end).toBeGreaterThan(0);
  const block = text.slice(4, end);
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

describe('formatSourcePage', () => {
  it('starts with frontmatter and contains a closing ---', () => {
    const out = formatSourcePage(baseSourceInput());
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.includes('\n---\n')).toBe(true);
  });

  it('frontmatter contains all required keys', () => {
    const out = formatSourcePage(baseSourceInput());
    const fm = parseFrontmatter(out);
    expect(fm.type).toBe('source');
    expect(fm.status).toBe('ingested');
    expect(fm.url).toBe('https://arxiv.org/abs/2605.03823');
    expect(fm.source_name).toBe('arXiv');
    expect(fm.collected).toBe('2026-05-01');
    expect(fm.title).toBe('"A Study of Things"');
    expect(fm.field).toBe('AI/ML');
    expect(fm.topics).toBe('[bayes-consistency, healthcare-ai]');
    expect(fm.cites).toBe('[arxiv-2403-12834]');
  });

  it('body contains H1 title, blockquote, sections, wikilinks', () => {
    const out = formatSourcePage(baseSourceInput());
    expect(out).toContain('# A Study of Things');
    expect(out).toContain(
      '> [arXiv (2026-05-01)](https://arxiv.org/abs/2605.03823) — collected by chiya-librarian on 2026-05-01.',
    );
    expect(out).toContain('## Summary');
    expect(out).toContain('This is the first paragraph.');
    expect(out).toContain('## Topics');
    expect(out).toContain('- [[wiki/topics/bayes-consistency]]');
    expect(out).toContain('- [[wiki/topics/healthcare-ai]]');
    expect(out).toContain('## Cited references in this library');
    expect(out).toContain('- [[wiki/sources/arxiv-2403-12834]]');
    expect(out).toContain('## Cited by');
  });

  it('empty topics → "_None yet._"', () => {
    const out = formatSourcePage(baseSourceInput({ topics: [] }));
    const after = out.split('## Topics')[1]!;
    expect(after).toMatch(/_None yet\._/);
  });

  it('sole uncategorized topic renders as plain text, never a wikilink', () => {
    const out = formatSourcePage(baseSourceInput({ topics: ['uncategorized'] }));
    const after = out.split('## Topics')[1]!;
    expect(after).toContain('- uncategorized (no topic assigned yet)');
    expect(out).not.toContain('[[wiki/topics/uncategorized]]');
    // Frontmatter stays queryable.
    expect(parseFrontmatter(out).topics).toBe('[uncategorized]');
  });

  it('uncategorized alongside real topics: real slugs linked, sentinel unlinked', () => {
    const out = formatSourcePage(
      baseSourceInput({ topics: ['bayes-consistency', 'uncategorized'] }),
    );
    expect(out).toContain('- [[wiki/topics/bayes-consistency]]');
    expect(out).toContain('- uncategorized');
    expect(out).not.toContain('[[wiki/topics/uncategorized]]');
    expect(out).not.toContain('(no topic assigned yet)');
  });

  it('empty cites → "_None resolved against the current library._"', () => {
    const out = formatSourcePage(baseSourceInput({ cites: [] }));
    const after = out.split('## Cited references in this library')[1]!;
    expect(after).toMatch(/_None resolved against the current library\._/);
  });

  it('title with double quotes round-trips through valid YAML', () => {
    const out = formatSourcePage(
      baseSourceInput({ title: 'Quotes "inside" the title' }),
    );
    const fm = parseFrontmatter(out);
    // YAML double-quoted scalar: parse by JSON since JSON.stringify is the encoder.
    expect(JSON.parse(fm.title!)).toBe('Quotes "inside" the title');
    // H1 should still contain the raw title
    expect(out).toContain('# Quotes "inside" the title');
  });

  it('arxiv_id present when arxiv, omitted otherwise', () => {
    const arx = formatSourcePage(baseSourceInput());
    expect(parseFrontmatter(arx).arxiv_id).toBe('2605.03823');
    const url = formatSourcePage(
      baseSourceInput({
        stableId: { kind: 'url', hash: '0123456789ab' },
        url: 'https://example.com/foo',
        arxivId: undefined,
      }),
    );
    expect(parseFrontmatter(url).arxiv_id).toBeUndefined();
  });

  it('null sourceName / null field render as "unknown"', () => {
    const out = formatSourcePage(
      baseSourceInput({ sourceName: null, field: null }),
    );
    const fm = parseFrontmatter(out);
    expect(fm.source_name).toBe('unknown');
    expect(fm.field).toBe('unknown');
  });

  it('rigor / evidence render when scored', () => {
    const fm = parseFrontmatter(formatSourcePage(baseSourceInput({ rigor: 4, evidence: 3 })));
    expect(fm.rigor).toBe('4');
    expect(fm.evidence).toBe('3');
  });

  it('rigor / evidence omitted entirely when unknown (legacy rows)', () => {
    const undef = formatSourcePage(baseSourceInput());
    expect(parseFrontmatter(undef).rigor).toBeUndefined();
    expect(parseFrontmatter(undef).evidence).toBeUndefined();
    expect(undef).not.toContain('rigor:');
    expect(undef).not.toContain('evidence:');

    const nulled = formatSourcePage(baseSourceInput({ rigor: null, evidence: null }));
    expect(nulled).not.toContain('rigor:');
    expect(nulled).not.toContain('evidence:');
  });

  it('one score known, the other unknown → only the known line', () => {
    const fm = parseFrontmatter(formatSourcePage(baseSourceInput({ rigor: 2 })));
    expect(fm.rigor).toBe('2');
    expect(fm.evidence).toBeUndefined();
  });

  it('cited_by: 0 present on every new source page', () => {
    expect(parseFrontmatter(formatSourcePage(baseSourceInput())).cited_by).toBe('0');
    expect(
      parseFrontmatter(formatSourcePage(baseSourceInput({ rigor: 5, evidence: 5 }))).cited_by,
    ).toBe('0');
  });

  it('cited_by is bumpable in place by the lint pass', () => {
    const page = formatSourcePage(baseSourceInput());
    const bumped = bumpFrontmatterField(page, 'cited_by', 7);
    expect(parseFrontmatter(bumped).cited_by).toBe('7');
    // In place — not appended as a second key.
    expect(bumped.split('cited_by:')).toHaveLength(2);
  });

  it('Cited by section starts empty', () => {
    const out = formatSourcePage(baseSourceInput());
    const idx = out.indexOf('## Cited by');
    expect(idx).toBeGreaterThan(0);
    const tail = out.slice(idx + '## Cited by'.length);
    // No `- [[wiki/sources/...]]` lines after the heading.
    expect(tail).not.toMatch(/- \[\[wiki\/sources\//);
  });
});

const baseTopicInput = (overrides: Partial<TopicPageInput> = {}): TopicPageInput => ({
  slug: 'healthcare-ai',
  created: new Date('2026-04-15T00:00:00Z'),
  updated: new Date('2026-05-01T00:00:00Z'),
  definition: 'Topic description goes here.',
  members: [],
  relatedTopics: [],
  ...overrides,
});

describe('formatTopicPage', () => {
  it('empty members → "_None yet._"', () => {
    const out = formatTopicPage(baseTopicInput());
    const after = out.split('## Member sources')[1]!;
    expect(after).toMatch(/_None yet\._/);
  });

  it('members sorted newest-first by collected', () => {
    const out = formatTopicPage(
      baseTopicInput({
        members: [
          {
            filename: 'arxiv-old',
            title: 'Old paper',
            collected: new Date('2026-01-01T00:00:00Z'),
          },
          {
            filename: 'arxiv-new',
            title: 'New paper',
            collected: new Date('2026-04-30T00:00:00Z'),
          },
          {
            filename: 'arxiv-mid',
            title: 'Mid paper',
            collected: new Date('2026-03-15T00:00:00Z'),
          },
        ],
      }),
    );
    const idxNew = out.indexOf('arxiv-new');
    const idxMid = out.indexOf('arxiv-mid');
    const idxOld = out.indexOf('arxiv-old');
    expect(idxNew).toBeGreaterThan(0);
    expect(idxMid).toBeGreaterThan(idxNew);
    expect(idxOld).toBeGreaterThan(idxMid);
  });

  it('empty relatedTopics omits the entire ## Related topics heading', () => {
    const out = formatTopicPage(baseTopicInput());
    expect(out).not.toContain('## Related topics');
  });

  it('non-empty relatedTopics renders heading + items', () => {
    const out = formatTopicPage(
      baseTopicInput({
        relatedTopics: [
          { slug: 'bayes-consistency', reason: 'shared methodology' },
          { slug: 'medical-imaging', reason: 'overlapping domain' },
        ],
      }),
    );
    expect(out).toContain('## Related topics');
    expect(out).toContain('- [[wiki/topics/bayes-consistency]] — shared methodology');
    expect(out).toContain('- [[wiki/topics/medical-imaging]] — overlapping domain');
  });

  it('slug "healthcare-ai" → H1 "Healthcare Ai"', () => {
    const out = formatTopicPage(baseTopicInput());
    expect(out).toContain('# Healthcare Ai');
  });

  it('frontmatter sources count matches members.length', () => {
    const out = formatTopicPage(
      baseTopicInput({
        members: [
          {
            filename: 'a',
            title: 'A',
            collected: new Date('2026-01-01T00:00:00Z'),
          },
          {
            filename: 'b',
            title: 'B',
            collected: new Date('2026-02-01T00:00:00Z'),
          },
        ],
      }),
    );
    const fm = parseFrontmatter(out);
    expect(fm.sources).toBe('2');
  });

  it('omits the clusters field when not provided', () => {
    const out = formatTopicPage(baseTopicInput());
    expect(out).not.toContain('clusters:');
  });

  it('omits the clusters field when explicitly empty', () => {
    const out = formatTopicPage(baseTopicInput({ clusters: [] }));
    expect(out).not.toContain('clusters:');
  });

  it('emits clusters as inline array when non-empty', () => {
    const out = formatTopicPage(baseTopicInput({ clusters: ['physics', 'computing'] }));
    expect(out).toContain('clusters: [physics, computing]');
    // sits in frontmatter between sources and related_topics
    const fm = parseFrontmatter(out);
    expect(fm.clusters).toBe('[physics, computing]');
  });

  it('emits a single-element clusters array correctly', () => {
    const out = formatTopicPage(baseTopicInput({ clusters: ['ai-ml'] }));
    expect(out).toContain('clusters: [ai-ml]');
  });
});

describe('appendMemberSource', () => {
  const base = (): string =>
    formatTopicPage(
      baseTopicInput({
        members: [
          {
            filename: 'arxiv-existing',
            title: 'Existing paper',
            collected: new Date('2026-03-01T00:00:00Z'),
          },
        ],
      }),
    );

  it('idempotent: re-adding existing returns byte-equal text', () => {
    const text = base();
    const out = appendMemberSource(text, {
      filename: 'arxiv-existing',
      title: 'Existing paper',
      collected: new Date('2026-03-01T00:00:00Z'),
    });
    expect(out).toBe(text);
  });

  it('new member: list grows, sources bumps by 1, updated → today', () => {
    const text = base();
    const out = appendMemberSource(text, {
      filename: 'arxiv-fresh',
      title: 'Fresh paper',
      collected: new Date('2026-04-30T00:00:00Z'),
    });
    expect(out).toContain('arxiv-fresh');
    const fm = parseFrontmatter(out);
    expect(fm.sources).toBe('2');
    expect(fm.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('newer member sorts to the top', () => {
    const text = base();
    const out = appendMemberSource(text, {
      filename: 'arxiv-fresh',
      title: 'Fresh paper',
      collected: new Date('2026-04-30T00:00:00Z'),
    });
    const idxFresh = out.indexOf('arxiv-fresh');
    const idxExisting = out.indexOf('arxiv-existing');
    expect(idxFresh).toBeGreaterThan(0);
    expect(idxFresh).toBeLessThan(idxExisting);
  });

  it('replaces "_None yet._" when first member is added', () => {
    const empty = formatTopicPage(baseTopicInput());
    expect(empty).toContain('_None yet._');
    const out = appendMemberSource(empty, {
      filename: 'arxiv-first',
      title: 'First paper',
      collected: new Date('2026-04-30T00:00:00Z'),
    });
    expect(out).not.toContain('_None yet._');
    expect(out).toContain('- [[wiki/sources/arxiv-first]] — First paper (2026-04-30)');
    expect(parseFrontmatter(out).sources).toBe('1');
  });
});

describe('appendCitedBy', () => {
  const base = (): string => formatSourcePage(baseSourceInput());

  it('idempotent: re-adding same citing source returns byte-equal text', () => {
    const text = base();
    const once = appendCitedBy(text, {
      filename: 'arxiv-citer',
      title: 'A citing paper',
    });
    const twice = appendCitedBy(once, {
      filename: 'arxiv-citer',
      title: 'A citing paper',
    });
    expect(twice).toBe(once);
  });

  it('new citing source: list grows', () => {
    const text = base();
    const out = appendCitedBy(text, {
      filename: 'arxiv-citer',
      title: 'A citing paper',
    });
    expect(out).toContain('- [[wiki/sources/arxiv-citer]] — A citing paper');
  });

  it('frontmatter is NOT touched by appendCitedBy', () => {
    const text = base();
    const before = parseFrontmatter(text);
    const out = appendCitedBy(text, {
      filename: 'arxiv-citer',
      title: 'A citing paper',
    });
    const after = parseFrontmatter(out);
    expect(after).toEqual(before);
  });

  it('multiple citers append in order', () => {
    const text = base();
    const a = appendCitedBy(text, { filename: 'arxiv-a', title: 'A' });
    const b = appendCitedBy(a, { filename: 'arxiv-b', title: 'B' });
    expect(b.indexOf('arxiv-a')).toBeLessThan(b.indexOf('arxiv-b'));
  });
});

describe('bumpFrontmatterField', () => {
  const sample = `---\ntype: topic\nsources: 3\nupdated: 2026-04-01\n---\n\n# Body\n\nSome content here.\n`;

  it('updates an existing scalar; preserves other fields and body exactly', () => {
    const out = bumpFrontmatterField(sample, 'sources', 7);
    const fm = parseFrontmatter(out);
    expect(fm.type).toBe('topic');
    expect(fm.sources).toBe('7');
    expect(fm.updated).toBe('2026-04-01');
    expect(out.endsWith('# Body\n\nSome content here.\n')).toBe(true);
  });

  it('inserts a non-existent field before the closing ---, body preserved', () => {
    const out = bumpFrontmatterField(sample, 'new_field', 'hello');
    const fm = parseFrontmatter(out);
    expect(fm.new_field).toBe('hello');
    expect(fm.type).toBe('topic');
    expect(out.endsWith('# Body\n\nSome content here.\n')).toBe(true);
  });

  it('numeric values render as bare numbers', () => {
    const out = bumpFrontmatterField(sample, 'count', 42);
    expect(out).toContain('count: 42');
  });

  it('string values with spaces render as-is', () => {
    const out = bumpFrontmatterField(sample, 'note', 'has spaces here');
    expect(parseFrontmatter(out).note).toBe('has spaces here');
  });

  it('JSON-stringified strings survive round-trip', () => {
    const value = JSON.stringify('weird: value with "quotes"');
    const out = bumpFrontmatterField(sample, 'title', value);
    expect(parseFrontmatter(out).title).toBe(value);
    expect(JSON.parse(parseFrontmatter(out).title!)).toBe('weird: value with "quotes"');
  });

  it('returns text unchanged if no frontmatter present', () => {
    const noFm = '# Just a body\n\nNothing else.\n';
    expect(bumpFrontmatterField(noFm, 'foo', 'bar')).toBe(noFm);
  });
});

describe('demoteH2 (rich summaries nested under ## Summary)', () => {
  it('demotes H2 headings to H3, leaving other levels alone', () => {
    const summary = '## Overview\nProse.\n\n## Findings\nMore prose.\n\n# NotTouched\n### AlreadyH3';
    expect(demoteH2(summary)).toBe(
      '### Overview\nProse.\n\n### Findings\nMore prose.\n\n# NotTouched\n### AlreadyH3',
    );
  });

  it('is a no-op for plain prose (legacy snippet summaries)', () => {
    const prose = 'Just a plain paragraph. Nothing structured.';
    expect(demoteH2(prose)).toBe(prose);
  });

  it('formatSourcePage nests a structured summary one level below ## Summary', () => {
    const page = formatSourcePage({
      stableId: { kind: 'arxiv', id: '2606.11111' },
      url: 'https://arxiv.org/abs/2606.11111',
      arxivId: '2606.11111',
      sourceName: 'arXiv',
      collected: new Date('2026-06-28T00:00:00Z'),
      title: 'A Paper',
      field: 'AI/ML',
      topics: [],
      cites: [],
      summary: '## Overview\nThe paper proposes X.\n\n## Findings\nIt works.',
    });
    expect(page).toContain('## Summary');
    expect(page).toContain('### Overview');
    expect(page).toContain('### Findings');
    // The original H2 section names must not appear at H2 level anymore.
    expect(page).not.toContain('\n## Overview');
    expect(page).not.toContain('\n## Findings');
  });
});

describe('formatSourcePage external references', () => {
  const base = {
    stableId: { kind: 'arxiv', id: '2606.11111' } as StableId,
    url: 'https://arxiv.org/abs/2606.11111',
    sourceName: 'arXiv',
    collected: new Date('2026-07-01T00:00:00Z'),
    title: 'A Paper',
    field: 'AI/ML',
    topics: [],
    cites: [],
    summary: 'Prose summary.',
  };

  it('renders unresolved refs as annotated external links', () => {
    const page = formatSourcePage({
      ...base,
      externalRefs: [
        { label: 'arXiv:1607.08221', url: 'https://arxiv.org/abs/1607.08221' },
        { label: 'doi:10.1/x', url: 'https://doi.org/10.1/x' },
      ],
    });
    expect(page).toContain('## External references');
    expect(page).toContain('- [arXiv:1607.08221](https://arxiv.org/abs/1607.08221) — not yet in library');
    expect(page).toContain('- [doi:10.1/x](https://doi.org/10.1/x) — not yet in library');
  });

  it('omits the section entirely when there are none', () => {
    const page = formatSourcePage(base);
    expect(page).not.toContain('## External references');
  });
});

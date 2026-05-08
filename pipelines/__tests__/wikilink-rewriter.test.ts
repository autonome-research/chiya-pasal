import { describe, it, expect } from 'vitest';
import {
  rewriteWikilinks,
  listWikilinkTargets,
  type RenameMap,
} from '../src/shared/wikilink-rewriter.js';

function map(entries: Array<[string, string]>): RenameMap {
  return new Map(entries);
}

describe('rewriteWikilinks - basic rewrites', () => {
  it('single wikilink, no alias / fragment', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('see [[wiki/topics/old]] here', m)).toBe(
      'see [[wiki/topics/new]] here',
    );
  });

  it('multiple wikilinks in one document all rewrite', () => {
    const m = map([
      ['wiki/topics/old-a', 'wiki/topics/new-a'],
      ['wiki/topics/old-b', 'wiki/topics/new-b'],
    ]);
    const input = 'first [[wiki/topics/old-a]] then [[wiki/topics/old-b]] done';
    expect(rewriteWikilinks(input, m)).toBe(
      'first [[wiki/topics/new-a]] then [[wiki/topics/new-b]] done',
    );
  });

  it('wikilink not in map left unchanged', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('look at [[wiki/topics/other]]', m)).toBe(
      'look at [[wiki/topics/other]]',
    );
  });
});

describe('rewriteWikilinks - form preservation', () => {
  it('alias preserved', () => {
    const m = map([['wiki/old', 'wiki/new']]);
    expect(rewriteWikilinks('[[wiki/old|My Topic]]', m)).toBe('[[wiki/new|My Topic]]');
  });

  it('fragment preserved', () => {
    const m = map([['wiki/old', 'wiki/new']]);
    expect(rewriteWikilinks('[[wiki/old#section]]', m)).toBe('[[wiki/new#section]]');
  });

  it('combined fragment + alias preserved', () => {
    const m = map([['wiki/old', 'wiki/new']]);
    expect(rewriteWikilinks('[[wiki/old#section|alias]]', m)).toBe(
      '[[wiki/new#section|alias]]',
    );
  });

  it('.md suffix preserved', () => {
    const m = map([['wiki/old', 'wiki/new']]);
    expect(rewriteWikilinks('[[wiki/old.md]]', m)).toBe('[[wiki/new.md]]');
  });

  it('mixed shapes in one document each preserved', () => {
    const m = map([
      ['wiki/topics/a', 'wiki/topics/A'],
      ['wiki/topics/b', 'wiki/topics/B'],
      ['wiki/topics/c', 'wiki/topics/C'],
    ]);
    const input = [
      '[[wiki/topics/a]]',
      '[[wiki/topics/b|Bee]]',
      '[[wiki/topics/c#part|Cee]]',
      '[[wiki/topics/a.md]]',
    ].join(' / ');
    const expected = [
      '[[wiki/topics/A]]',
      '[[wiki/topics/B|Bee]]',
      '[[wiki/topics/C#part|Cee]]',
      '[[wiki/topics/A.md]]',
    ].join(' / ');
    expect(rewriteWikilinks(input, m)).toBe(expected);
  });
});

describe('rewriteWikilinks - lookup forms', () => {
  // Rule: the rewritten link preserves the original wikilink's `wiki/` prefix
  // form. If the wikilink had no `wiki/` prefix, neither does the output, even
  // if the new path in the map carries one.
  it('map key has wiki/ prefix; wikilink does not - resolves and preserves no-prefix style', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('[[topics/old]]', m)).toBe('[[topics/new]]');
  });

  it('map key without wiki/; wikilink has prefix - resolves and keeps prefix', () => {
    const m = map([['topics/old', 'topics/new']]);
    expect(rewriteWikilinks('[[wiki/topics/old]]', m)).toBe('[[wiki/topics/new]]');
  });

  it('.md suffix in wikilink not in key - resolves and preserves .md form', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('[[wiki/topics/old.md]]', m)).toBe('[[wiki/topics/new.md]]');
  });
});

describe('rewriteWikilinks - skip cases', () => {
  it('inside fenced code block left alone', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    const input = ['before [[wiki/topics/old]]', '```', '[[wiki/topics/old]]', '```', 'after [[wiki/topics/old]]'].join('\n');
    const expected = ['before [[wiki/topics/new]]', '```', '[[wiki/topics/old]]', '```', 'after [[wiki/topics/new]]'].join('\n');
    expect(rewriteWikilinks(input, m)).toBe(expected);
  });

  it('inside tilde fence left alone', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    const input = ['~~~', '[[wiki/topics/old]]', '~~~'].join('\n');
    expect(rewriteWikilinks(input, m)).toBe(input);
  });

  it('inside inline code left alone', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('text `[[wiki/topics/old]]` more', m)).toBe(
      'text `[[wiki/topics/old]]` more',
    );
  });

  it('escaped open bracket not treated as wikilink', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('\\[[wiki/topics/old]]', m)).toBe(
      '\\[[wiki/topics/old]]',
    );
  });

  it('empty wikilink does not crash and is left alone', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('see [[]] here', m)).toBe('see [[]] here');
  });

  it('same-page anchor left alone', () => {
    const m = map([['wiki/topics/old', 'wiki/topics/new']]);
    expect(rewriteWikilinks('jump to [[#section]]', m)).toBe(
      'jump to [[#section]]',
    );
  });

  it('empty map returns text unchanged', () => {
    expect(rewriteWikilinks('[[wiki/topics/old]]', new Map())).toBe(
      '[[wiki/topics/old]]',
    );
  });
});

describe('listWikilinkTargets', () => {
  it('deduplicates across multiple wikilinks pointing at the same target', () => {
    const text = '[[wiki/topics/foo]] and [[wiki/topics/foo|alias]] and [[wiki/topics/foo#section]]';
    const targets = listWikilinkTargets(text);
    expect(targets.size).toBe(1);
    expect(targets.has('wiki/topics/foo')).toBe(true);
  });

  it('strips .md, fragments, aliases - returns just the path', () => {
    const text = '[[wiki/a.md]] [[wiki/b#frag]] [[wiki/c|alias]] [[wiki/d#frag|alias]]';
    const targets = listWikilinkTargets(text);
    expect(targets).toEqual(new Set(['wiki/a', 'wiki/b', 'wiki/c', 'wiki/d']));
  });

  it('empty input returns empty set', () => {
    expect(listWikilinkTargets('')).toEqual(new Set());
  });

  it('input without wikilinks returns empty set', () => {
    expect(listWikilinkTargets('just prose with no links at all')).toEqual(new Set());
  });

  it('skips wikilinks inside code regions', () => {
    const text = ['real [[wiki/topics/real]]', '```', '[[wiki/topics/fenced]]', '```', '`[[wiki/topics/inline]]`'].join('\n');
    const targets = listWikilinkTargets(text);
    expect(targets).toEqual(new Set(['wiki/topics/real']));
  });

  it('ignores same-page anchors and empty links', () => {
    const text = 'see [[#section]] and [[]] and [[real/path]]';
    expect(listWikilinkTargets(text)).toEqual(new Set(['real/path']));
  });
});

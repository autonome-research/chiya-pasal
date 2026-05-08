import { describe, it, expect } from 'vitest';
import {
  extractDefinition,
  flattenTopicPath,
  topicSlugFromPath,
  planCollisions,
} from '../src/migrate-topics-v2.js';

describe('extractDefinition', () => {
  it('extracts the first paragraph after the H1, before any ## heading', () => {
    const text = `---
type: topic
updated: 2026-05-06
---

# Robotics

Robotics is the interdisciplinary field involving the design of robots.

## Key Research Areas

stuff
`;
    expect(extractDefinition(text)).toBe(
      'Robotics is the interdisciplinary field involving the design of robots.',
    );
  });

  it('returns only the first paragraph when multiple paragraphs precede the first ## heading', () => {
    const text = `# Foo

First paragraph here.

Second paragraph that should NOT be returned.

## Section
`;
    expect(extractDefinition(text)).toBe('First paragraph here.');
  });

  it('handles a multi-line paragraph as one definition', () => {
    const text = `# Foo

This is a paragraph
that spans multiple lines
of source text.

## Next
`;
    expect(extractDefinition(text)).toBe(
      'This is a paragraph\nthat spans multiple lines\nof source text.',
    );
  });

  it('returns the first paragraph after frontmatter when no H1 is present', () => {
    const text = `---
type: topic
---

A bare paragraph that serves as the definition.

## Sources
`;
    expect(extractDefinition(text)).toBe(
      'A bare paragraph that serves as the definition.',
    );
  });

  it('returns empty string when the body is empty', () => {
    const text = `---
type: topic
---

`;
    expect(extractDefinition(text)).toBe('');
  });

  it('returns empty string when only an H1 is present (no body paragraph)', () => {
    const text = `# Foo

## Sources

- something
`;
    expect(extractDefinition(text)).toBe('');
  });

  it('preserves wikilinks verbatim inside the definition', () => {
    const text = `# Robotics

Robotics integrates [[wiki/topics/ai-ml/visual-reasoning-vlms|VLMs]] and [[wiki/outputs/multi-agent-systems|multi-agent systems]].

## Areas
`;
    expect(extractDefinition(text)).toBe(
      'Robotics integrates [[wiki/topics/ai-ml/visual-reasoning-vlms|VLMs]] and [[wiki/outputs/multi-agent-systems|multi-agent systems]].',
    );
  });

  it('handles a page with no frontmatter at all', () => {
    const text = `# Foo

Just a paragraph.

## End
`;
    expect(extractDefinition(text)).toBe('Just a paragraph.');
  });
});

describe('flattenTopicPath', () => {
  it('flattens a one-level nested path', () => {
    expect(flattenTopicPath('wiki/topics/ai-ml/foo.md')).toBe('wiki/topics/foo.md');
  });

  it('leaves an already-flat path unchanged', () => {
    expect(flattenTopicPath('wiki/topics/foo.md')).toBe('wiki/topics/foo.md');
  });

  it('flattens a deeply nested path; deepest basename wins', () => {
    expect(flattenTopicPath('wiki/topics/ai-ml/sub/foo.md')).toBe('wiki/topics/foo.md');
  });

  it('returns input unchanged for paths outside wiki/topics/', () => {
    expect(flattenTopicPath('wiki/entities/openai.md')).toBe('wiki/entities/openai.md');
    expect(flattenTopicPath('raw/something.md')).toBe('raw/something.md');
  });
});

describe('topicSlugFromPath', () => {
  it('returns the slug from a flat path', () => {
    expect(topicSlugFromPath('wiki/topics/foo.md')).toBe('foo');
  });

  it('returns the slug from a nested path', () => {
    expect(topicSlugFromPath('wiki/topics/ai-ml/foo.md')).toBe('foo');
  });

  it('handles a path without .md extension', () => {
    expect(topicSlugFromPath('wiki/topics/foo')).toBe('foo');
  });
});

describe('planCollisions', () => {
  it('returns all inputs as resolved when there are no conflicts', () => {
    const result = planCollisions([
      { oldPath: 'wiki/topics/a.md', newPath: 'wiki/topics/a.md', memberCount: 3 },
      { oldPath: 'wiki/topics/b.md', newPath: 'wiki/topics/b.md', memberCount: 0 },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toEqual(
      expect.arrayContaining([
        { oldPath: 'wiki/topics/a.md', newPath: 'wiki/topics/a.md' },
        { oldPath: 'wiki/topics/b.md', newPath: 'wiki/topics/b.md' },
      ]),
    );
    expect(result.resolved).toHaveLength(2);
  });

  it('chooses the candidate with the larger memberCount on a 2-way conflict', () => {
    const result = planCollisions([
      { oldPath: 'wiki/topics/ai-ml/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 1 },
      { oldPath: 'wiki/topics/physics/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 5 },
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.newPath).toBe('wiki/topics/foo.md');
    expect(result.conflicts[0]!.chosen).toBe('wiki/topics/physics/foo.md');
    expect(result.resolved).toEqual([
      { oldPath: 'wiki/topics/physics/foo.md', newPath: 'wiki/topics/foo.md' },
    ]);
  });

  it('breaks ties lexicographically on equal member counts', () => {
    const result = planCollisions([
      { oldPath: 'wiki/topics/zebra/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 2 },
      { oldPath: 'wiki/topics/alpha/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 2 },
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.chosen).toBe('wiki/topics/alpha/foo.md');
    expect(result.resolved).toEqual([
      { oldPath: 'wiki/topics/alpha/foo.md', newPath: 'wiki/topics/foo.md' },
    ]);
  });

  it('handles a 3-way conflict; only the winner is resolved', () => {
    const result = planCollisions([
      { oldPath: 'wiki/topics/a/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 1 },
      { oldPath: 'wiki/topics/b/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 4 },
      { oldPath: 'wiki/topics/c/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 2 },
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.candidates).toHaveLength(3);
    expect(result.conflicts[0]!.chosen).toBe('wiki/topics/b/foo.md');
    expect(result.resolved).toEqual([
      { oldPath: 'wiki/topics/b/foo.md', newPath: 'wiki/topics/foo.md' },
    ]);
    // Losers do NOT appear in resolved.
    const resolvedOlds = result.resolved.map((r) => r.oldPath);
    expect(resolvedOlds).not.toContain('wiki/topics/a/foo.md');
    expect(resolvedOlds).not.toContain('wiki/topics/c/foo.md');
  });

  it('mixes resolved + conflicting outputs cleanly', () => {
    const result = planCollisions([
      { oldPath: 'wiki/topics/standalone.md', newPath: 'wiki/topics/standalone.md', memberCount: 0 },
      { oldPath: 'wiki/topics/x/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 3 },
      { oldPath: 'wiki/topics/y/foo.md', newPath: 'wiki/topics/foo.md', memberCount: 1 },
    ]);
    expect(result.resolved).toEqual(
      expect.arrayContaining([
        { oldPath: 'wiki/topics/standalone.md', newPath: 'wiki/topics/standalone.md' },
        { oldPath: 'wiki/topics/x/foo.md', newPath: 'wiki/topics/foo.md' },
      ]),
    );
    expect(result.resolved).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
  });
});

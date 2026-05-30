import { describe, it, expect } from 'vitest';
import {
  extractDefinition,
  flattenTopicPath,
  topicSlugFromPath,
  planCollisions,
  clustersFromOldPath,
  foldLosersIntoWinner,
} from '../scripts/migrate-topics.js';

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

describe('clustersFromOldPath', () => {
  it('returns a single cluster for one-level nesting', () => {
    expect(clustersFromOldPath('wiki/topics/physics/quantum-sensing.md')).toEqual(['physics']);
    expect(clustersFromOldPath('wiki/topics/ai-ml/agent-memory.md')).toEqual(['ai-ml']);
  });

  it('returns an empty list for a flat path', () => {
    expect(clustersFromOldPath('wiki/topics/quantum-sensing.md')).toEqual([]);
  });

  it('returns all intermediate dirs for deeper nesting', () => {
    expect(clustersFromOldPath('wiki/topics/biology/digital-twin/foo.md')).toEqual([
      'biology',
      'digital-twin',
    ]);
  });

  it('returns an empty list for paths outside wiki/topics/', () => {
    expect(clustersFromOldPath('wiki/entities/openai.md')).toEqual([]);
    expect(clustersFromOldPath('raw/inbox/2026-05.md')).toEqual([]);
  });
});

describe('foldLosersIntoWinner', () => {
  const today = new Date('2026-05-17T00:00:00Z');
  const baseDate = new Date('2026-04-01T00:00:00Z');

  // Helper to make a PagePlan-shaped object without dragging in the full
  // interface. The fold function only reads a subset of fields; we rebuild
  // newContent on the way out so its initial value doesn't matter.
  function plan(overrides: {
    oldPath: string;
    clusters: string[];
    definition?: string;
    members?: Array<{ filename: string; title: string; collected: Date }>;
  }): Parameters<typeof foldLosersIntoWinner>[0] {
    const newPath = 'wiki/topics/foo.md';
    const definition = overrides.definition ?? '';
    const members = overrides.members ?? [];
    return {
      oldPath: overrides.oldPath,
      newPath,
      slug: 'foo',
      definition,
      definitionStatus: definition.length > 0 ? 'extracted' : 'empty',
      members,
      memberCount: members.length,
      skippedNoUrl: 0,
      created: baseDate,
      clusters: overrides.clusters,
      newContent: '',
    };
  }

  it('unions clusters across winner + losers, preserving winner-first order', () => {
    const winner = plan({ oldPath: 'wiki/topics/physics/foo.md', clusters: ['physics'] });
    const losers = [
      plan({ oldPath: 'wiki/topics/computing/foo.md', clusters: ['computing'] }),
      plan({ oldPath: 'wiki/topics/foo.md', clusters: [] }),
    ];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.clusters).toEqual(['physics', 'computing']);
  });

  it('dedupes clusters that appear in both winner and losers', () => {
    const winner = plan({ oldPath: 'wiki/topics/physics/foo.md', clusters: ['physics'] });
    const losers = [
      plan({ oldPath: 'wiki/topics/physics/sub/foo.md', clusters: ['physics', 'sub'] }),
    ];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.clusters).toEqual(['physics', 'sub']);
  });

  it('unions member lists by filename; winner wins on collision', () => {
    const winner = plan({
      oldPath: 'wiki/topics/physics/foo.md',
      clusters: ['physics'],
      members: [
        { filename: 'arxiv-001', title: 'A (winner)', collected: baseDate },
      ],
    });
    const losers = [
      plan({
        oldPath: 'wiki/topics/computing/foo.md',
        clusters: ['computing'],
        members: [
          { filename: 'arxiv-001', title: 'A (loser)', collected: baseDate },
          { filename: 'arxiv-002', title: 'B', collected: baseDate },
        ],
      }),
    ];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.members.map((m) => m.filename).sort()).toEqual(['arxiv-001', 'arxiv-002']);
    const a = folded.members.find((m) => m.filename === 'arxiv-001');
    expect(a?.title).toBe('A (winner)');
    expect(folded.memberCount).toBe(2);
  });

  it('keeps winner definition when non-empty', () => {
    const winner = plan({
      oldPath: 'wiki/topics/physics/foo.md',
      clusters: ['physics'],
      definition: 'Winner definition.',
    });
    const losers = [
      plan({
        oldPath: 'wiki/topics/computing/foo.md',
        clusters: ['computing'],
        definition: 'A much longer loser definition that should not displace the winner.',
      }),
    ];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.definition).toBe('Winner definition.');
    expect(folded.definitionStatus).toBe('extracted');
  });

  it('falls back to longest non-empty loser definition when winner is empty', () => {
    const winner = plan({
      oldPath: 'wiki/topics/physics/foo.md',
      clusters: ['physics'],
      definition: '',
    });
    const losers = [
      plan({ oldPath: 'wiki/topics/a/foo.md', clusters: ['a'], definition: 'short.' }),
      plan({
        oldPath: 'wiki/topics/b/foo.md',
        clusters: ['b'],
        definition: 'a longer fallback definition with more substance.',
      }),
      plan({ oldPath: 'wiki/topics/c/foo.md', clusters: ['c'], definition: '' }),
    ];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.definition).toBe('a longer fallback definition with more substance.');
    expect(folded.definitionStatus).toBe('extracted');
  });

  it('preserves winner empty definition when no loser has one either', () => {
    const winner = plan({ oldPath: 'wiki/topics/physics/foo.md', clusters: ['physics'] });
    const losers = [plan({ oldPath: 'wiki/topics/computing/foo.md', clusters: ['computing'] })];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.definition).toBe('');
    expect(folded.definitionStatus).toBe('empty');
  });

  it('renders newContent with the merged clusters in frontmatter', () => {
    const winner = plan({
      oldPath: 'wiki/topics/physics/foo.md',
      clusters: ['physics'],
      definition: 'A foo.',
    });
    const losers = [plan({ oldPath: 'wiki/topics/computing/foo.md', clusters: ['computing'] })];
    const folded = foldLosersIntoWinner(winner, losers, today);
    expect(folded.newContent).toContain('clusters: [physics, computing]');
    expect(folded.newContent).toContain('A foo.');
  });
});

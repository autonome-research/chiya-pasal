import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  scanTopicRegistry,
  renderRegistryMarkdown,
  renderRegistryJson,
  vocabularyForPrompt,
  isKnownSlug,
  nearestSlugs,
  parseTopicPage,
  firstProseLine,
  memberSourceNames,
  type TopicRecord,
  type TopicRegistry,
} from '../src/shared/topic-registry.js';

const AT = '2026-08-02T00:00:00.000Z';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-registry-'));
  mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
  mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function topic(slug: string, content: string): void {
  writeFileSync(join(dir, 'wiki/topics', `${slug}.md`), content);
}
function source(name: string, content: string): void {
  writeFileSync(join(dir, 'wiki/sources', `${name}.md`), content);
}

/** A topic page in the shape formatTopicPage emits. */
function canonicalTopic(
  slug: string,
  opts: { clusters?: string[]; definition?: string; members?: string[]; updated?: string } = {},
): string {
  const fm = [
    '---',
    'type: topic',
    'status: active',
    'created: 2026-01-01',
    `updated: ${opts.updated ?? '2026-07-01'}`,
    `sources: ${(opts.members ?? []).length}`,
  ];
  if (opts.clusters && opts.clusters.length > 0) fm.push(`clusters: [${opts.clusters.join(', ')}]`);
  fm.push('related_topics: []', '---');
  const body = [
    '',
    `# ${slug}`,
    '',
    opts.definition ?? 'A definition sentence.',
    '',
    '## Member sources',
    '',
  ];
  for (const m of opts.members ?? []) body.push(`- [[wiki/sources/${m}]] — Title (2026-07-01)`);
  if ((opts.members ?? []).length === 0) body.push('_None yet._');
  body.push('');
  return `${fm.join('\n')}\n${body.join('\n')}`;
}

function fakeRecord(overrides: Partial<TopicRecord> & { slug: string }): TopicRecord {
  return {
    title: overrides.slug,
    oneLiner: null,
    clusters: [],
    memberCount: 0,
    citedByTotal: 0,
    updated: null,
    ...overrides,
  };
}

function fakeRegistry(records: TopicRecord[]): TopicRegistry {
  const clusters: Record<string, { topicCount: number }> = {};
  for (const r of records) {
    for (const c of new Set(r.clusters)) {
      clusters[c] = { topicCount: (clusters[c]?.topicCount ?? 0) + 1 };
    }
  }
  return { topics: [...records].sort((a, b) => (a.slug < b.slug ? -1 : 1)), clusters, generatedAt: AT };
}

describe('memberSourceNames', () => {
  it('collects wiki/sources wikilinks anywhere in the body', () => {
    const body = 'intro [[wiki/sources/arxiv-1]] mid\n\n## Sources\n\n- [[wiki/sources/arxiv-2]] — t\n';
    expect(memberSourceNames(body)).toEqual(['arxiv-1', 'arxiv-2']);
  });

  it('dedupes repeated links and preserves first-seen order', () => {
    const body = '- [[wiki/sources/b]]\n- [[wiki/sources/a]]\n- [[wiki/sources/b]]\n';
    expect(memberSourceNames(body)).toEqual(['b', 'a']);
  });

  it('handles piped labels and a trailing .md', () => {
    const body = '- [[wiki/sources/arxiv-1|Some Paper]]\n- [[wiki/sources/arxiv-2.md]]\n';
    expect(memberSourceNames(body)).toEqual(['arxiv-1', 'arxiv-2']);
  });

  it('ignores topic and entity wikilinks', () => {
    const body = '- [[wiki/topics/foo]]\n- [[wiki/entities/openai]]\n';
    expect(memberSourceNames(body)).toEqual([]);
  });
});

describe('firstProseLine', () => {
  it('returns the first sentence under the H1', () => {
    expect(firstProseLine('\n# Robotics\n\nRobotics is a field.\n\n## Member sources\n')).toBe(
      'Robotics is a field.',
    );
  });

  it('returns null when the body has only structure', () => {
    expect(firstProseLine('\n# Foo\n\n## Member sources\n\n- [[wiki/sources/a]]\n')).toBeNull();
  });

  it('rejects the _None yet._ placeholder as prose', () => {
    expect(firstProseLine('# Foo\n\n_None yet._\n')).toBeNull();
  });

  it('rejects a bare wikilink line', () => {
    expect(firstProseLine('# Foo\n\n[[wiki/topics/bar]]\n')).toBeNull();
  });

  it('works on a page with no H1', () => {
    expect(firstProseLine('\nJust a definition.\n')).toBe('Just a definition.');
  });
});

describe('parseTopicPage', () => {
  it('reads title, one-liner, clusters, updated and members from a canonical page', () => {
    const { record, members } = parseTopicPage(
      'agent-memory',
      canonicalTopic('Agent Memory', {
        clusters: ['ai-ml'],
        definition: 'Persistent state for agents.',
        members: ['arxiv-1', 'arxiv-2'],
        updated: '2026-07-29',
      }),
    );
    expect(record.slug).toBe('agent-memory');
    expect(record.title).toBe('Agent Memory');
    expect(record.oneLiner).toBe('Persistent state for agents.');
    expect(record.clusters).toEqual(['ai-ml']);
    expect(record.memberCount).toBe(2);
    expect(record.updated).toBe('2026-07-29');
    expect(members).toEqual(['arxiv-1', 'arxiv-2']);
  });

  it('falls back to a title-cased slug when there is no H1', () => {
    const { record } = parseTopicPage('quantum-sensing', 'no heading here at all\n');
    expect(record.title).toBe('Quantum Sensing');
  });

  it('treats a page with no frontmatter as all body', () => {
    const { record } = parseTopicPage('legacy', '# Legacy\n\nOld page.\n\n- [[wiki/sources/x]]\n');
    expect(record.clusters).toEqual([]);
    expect(record.updated).toBeNull();
    expect(record.memberCount).toBe(1);
    expect(record.oneLiner).toBe('Old page.');
  });

  it('reads clusters written as a YAML block list', () => {
    const text = '---\ntype: topic\nclusters:\n  - physics\n  - materials\n---\n\n# X\n';
    expect(parseTopicPage('x', text).record.clusters).toEqual(['physics', 'materials']);
  });

  it('reads a bare scalar clusters value', () => {
    const text = '---\nclusters: physics\n---\n\n# X\n';
    expect(parseTopicPage('x', text).record.clusters).toEqual(['physics']);
  });

  it('treats an empty inline array as no clusters', () => {
    const text = '---\nclusters: []\n---\n\n# X\n';
    expect(parseTopicPage('x', text).record.clusters).toEqual([]);
  });

  it('strips quotes from scalar values', () => {
    const text = '---\nupdated: "2026-07-29"\n---\n\n# X\n';
    expect(parseTopicPage('x', text).record.updated).toBe('2026-07-29');
  });
});

describe('scanTopicRegistry', () => {
  it('returns topics sorted by slug with cluster counts', () => {
    topic('zeta', canonicalTopic('Zeta', { clusters: ['physics'] }));
    topic('alpha', canonicalTopic('Alpha', { clusters: ['ai-ml', 'physics'] }));
    topic('mid', canonicalTopic('Mid'));

    const reg = scanTopicRegistry(dir, AT);
    expect(reg.topics.map((t) => t.slug)).toEqual(['alpha', 'mid', 'zeta']);
    expect(reg.clusters).toEqual({ 'ai-ml': { topicCount: 1 }, physics: { topicCount: 2 } });
    expect(reg.generatedAt).toBe(AT);
  });

  it('skips files starting with _ so it never ingests its own output', () => {
    topic('real', canonicalTopic('Real'));
    topic('_registry', '# Topic registry\n\n- [[wiki/topics/real]]\n');
    expect(scanTopicRegistry(dir, AT).topics.map((t) => t.slug)).toEqual(['real']);
  });

  it('ignores legacy empty domain directories under wiki/topics', () => {
    mkdirSync(join(dir, 'wiki/topics/ai-ml'), { recursive: true });
    writeFileSync(join(dir, 'wiki/topics/ai-ml/nested.md'), canonicalTopic('Nested'));
    topic('flat', canonicalTopic('Flat'));
    expect(scanTopicRegistry(dir, AT).topics.map((t) => t.slug)).toEqual(['flat']);
  });

  it('returns an empty registry when wiki/topics does not exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'chiya-registry-empty-'));
    try {
      const reg = scanTopicRegistry(empty, AT);
      expect(reg).toEqual({ topics: [], clusters: {}, generatedAt: AT });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('sums cited_by from member source frontmatter', () => {
    source('arxiv-1', '---\ntype: source\ncited_by: 4\n---\n\n# One\n');
    source('arxiv-2', '---\ntype: source\ncited_by: 3\n---\n\n# Two\n');
    source('arxiv-3', '---\ntype: source\n---\n\n# Three (no cited_by)\n');
    topic('t', canonicalTopic('T', { members: ['arxiv-1', 'arxiv-2', 'arxiv-3'] }));

    const reg = scanTopicRegistry(dir, AT);
    expect(reg.topics[0]!.memberCount).toBe(3);
    expect(reg.topics[0]!.citedByTotal).toBe(7);
  });

  it('scores citedByTotal 0 when members are missing from the vault', () => {
    topic('t', canonicalTopic('T', { members: ['ghost-1'] }));
    const reg = scanTopicRegistry(dir, AT);
    expect(reg.topics[0]!.memberCount).toBe(1);
    expect(reg.topics[0]!.citedByTotal).toBe(0);
  });

  it('counts a shared member once per topic', () => {
    source('shared', '---\ncited_by: 5\n---\n\n# S\n');
    topic('a', canonicalTopic('A', { members: ['shared'] }));
    topic('b', canonicalTopic('B', { members: ['shared'] }));
    const reg = scanTopicRegistry(dir, AT);
    expect(reg.topics.map((t) => t.citedByTotal)).toEqual([5, 5]);
  });
});

describe('renderRegistryMarkdown', () => {
  it('warns against hand-editing and lists clusters with member counts', () => {
    const reg = fakeRegistry([
      fakeRecord({ slug: 'agent-memory', clusters: ['ai-ml'], memberCount: 12 }),
      fakeRecord({ slug: 'llm-tool-use', clusters: ['ai-ml'], memberCount: 30 }),
      fakeRecord({ slug: 'quantum-sensing', clusters: ['physics'], memberCount: 4 }),
    ]);
    const md = renderRegistryMarkdown(reg);
    expect(md).toContain('**Do not hand-edit**');
    expect(md).toContain('### ai-ml (2)');
    expect(md).toContain('- [[wiki/topics/llm-tool-use]] — 30 sources');
    expect(md).toContain('### physics (1)');
    // Bigger cluster first, biggest topic first within it.
    expect(md.indexOf('### ai-ml')).toBeLessThan(md.indexOf('### physics'));
    expect(md.indexOf('llm-tool-use')).toBeLessThan(md.indexOf('agent-memory'));
  });

  it('shows citation totals only when non-zero', () => {
    const reg = fakeRegistry([
      fakeRecord({ slug: 'a', clusters: ['x'], memberCount: 1, citedByTotal: 9 }),
      fakeRecord({ slug: 'b', clusters: ['x'], memberCount: 1 }),
    ]);
    const md = renderRegistryMarkdown(reg);
    expect(md).toContain('- [[wiki/topics/a]] — 1 sources, 9 citations');
    expect(md).toContain('- [[wiki/topics/b]] — 1 sources\n');
  });

  it('caps the unclustered section at 50 and says so', () => {
    const reg = fakeRegistry(
      Array.from({ length: 60 }, (_, i) =>
        fakeRecord({ slug: `t-${String(i).padStart(2, '0')}`, memberCount: i }),
      ),
    );
    const md = renderRegistryMarkdown(reg);
    expect(md).toContain('## Unclustered topics');
    expect(md).toContain('60 topics have no cluster assigned.');
    expect(md).toContain('Showing the top 50 by member count');
    const listed = md.split('\n').filter((l) => l.startsWith('- [[wiki/topics/t-'));
    expect(listed).toHaveLength(50);
    // Highest member count first, lowest 10 elided.
    expect(listed[0]).toContain('t-59');
    expect(md).not.toContain('[[wiki/topics/t-00]]');
  });

  it('reports a stats footer', () => {
    const reg = fakeRegistry([
      fakeRecord({ slug: 'a', clusters: ['x'], memberCount: 2, citedByTotal: 3 }),
      fakeRecord({ slug: 'b', memberCount: 1 }),
    ]);
    const md = renderRegistryMarkdown(reg);
    expect(md).toContain('- Topics: 2');
    expect(md).toContain('- Clustered: 1');
    expect(md).toContain('- Unclustered: 1');
    expect(md).toContain('- Clusters: 1');
    expect(md).toContain('- Member links: 3');
    expect(md).toContain('- Citations into members: 3');
    expect(md).toContain(`- Generated: ${AT}`);
  });

  it('handles an empty vault', () => {
    const md = renderRegistryMarkdown(fakeRegistry([]));
    expect(md).toContain('_No clusters assigned yet._');
    expect(md).toContain('_None — every topic carries at least one cluster._');
    expect(md).toContain('- Topics: 0');
  });

  it('is byte-stable for the same registry', () => {
    const reg = fakeRegistry([fakeRecord({ slug: 'a', clusters: ['x'], memberCount: 1 })]);
    expect(renderRegistryMarkdown(reg)).toBe(renderRegistryMarkdown(reg));
  });
});

describe('renderRegistryJson', () => {
  it('emits stable ordering: clusters by count desc, topics by slug', () => {
    const reg = fakeRegistry([
      fakeRecord({ slug: 'b', clusters: ['ai-ml'], memberCount: 1 }),
      fakeRecord({ slug: 'a', clusters: ['ai-ml', 'physics'], memberCount: 2, citedByTotal: 5 }),
      fakeRecord({ slug: 'c' }),
    ]);
    const doc = JSON.parse(renderRegistryJson(reg));
    expect(doc.generatedAt).toBe(AT);
    expect(doc.clusters).toEqual([
      { name: 'ai-ml', topicCount: 2 },
      { name: 'physics', topicCount: 1 },
    ]);
    expect(doc.topics.map((t: { slug: string }) => t.slug)).toEqual(['a', 'b', 'c']);
    expect(doc.stats).toEqual({
      topicCount: 3,
      clusterCount: 2,
      clusteredTopicCount: 2,
      unclusteredTopicCount: 1,
      memberTotal: 3,
      citedByTotal: 5,
    });
  });

  it('carries every TopicRecord field through for the visualization tool', () => {
    const reg = fakeRegistry([
      fakeRecord({
        slug: 'a',
        title: 'Alpha',
        oneLiner: 'One line.',
        clusters: ['x'],
        memberCount: 2,
        citedByTotal: 1,
        updated: '2026-07-29',
      }),
    ]);
    const doc = JSON.parse(renderRegistryJson(reg));
    expect(doc.topics[0]).toEqual({
      slug: 'a',
      title: 'Alpha',
      oneLiner: 'One line.',
      clusters: ['x'],
      memberCount: 2,
      citedByTotal: 1,
      updated: '2026-07-29',
    });
  });

  it('produces identical bytes across runs', () => {
    const reg = fakeRegistry([fakeRecord({ slug: 'a', clusters: ['x'] })]);
    expect(renderRegistryJson(reg)).toBe(renderRegistryJson(reg));
    expect(renderRegistryJson(reg).endsWith('\n')).toBe(true);
  });
});

describe('vocabularyForPrompt', () => {
  const reg = fakeRegistry([
    fakeRecord({ slug: 'llm-tool-use', clusters: ['ai-ml'], memberCount: 30 }),
    fakeRecord({ slug: 'agent-memory', clusters: ['ai-ml'], memberCount: 12 }),
    fakeRecord({ slug: 'rlhf', clusters: ['ai-ml'], memberCount: 1 }),
    fakeRecord({ slug: 'quantum-sensing', clusters: ['physics'], memberCount: 4 }),
    fakeRecord({ slug: 'loose-topic', memberCount: 7 }),
  ]);

  it('groups by cluster, largest cluster first, largest topic first within', () => {
    const out = vocabularyForPrompt(reg, { maxChars: 1000 });
    expect(out).toBe(
      'ai-ml (3): llm-tool-use, agent-memory, rlhf\n' +
        'physics (1): quantum-sensing\n' +
        '(unclustered) (1): loose-topic',
    );
  });

  it('always includes unclustered topics — they are the ones needing filing', () => {
    expect(vocabularyForPrompt(reg, { maxChars: 1000 })).toContain('loose-topic');
  });

  it('elides within a group with (+N more) and never exceeds maxChars', () => {
    const out = vocabularyForPrompt(reg, { maxChars: 45 });
    expect(out.length).toBeLessThanOrEqual(45);
    expect(out).toContain('(+');
    expect(out).toContain('more)');
    expect(out.startsWith('ai-ml (3): llm-tool-use')).toBe(true);
  });

  it('respects maxChars strictly at every budget', () => {
    const big = fakeRegistry(
      Array.from({ length: 200 }, (_, i) =>
        fakeRecord({
          slug: `topic-with-a-long-name-${i}`,
          clusters: [`cluster-${i % 7}`],
          memberCount: i,
        }),
      ),
    );
    for (let budget = 0; budget <= 400; budget += 7) {
      const out = vocabularyForPrompt(big, { maxChars: budget });
      expect(out.length).toBeLessThanOrEqual(budget);
    }
  });

  it('gives every group a slug before any group gets a second', () => {
    // A greedy fill would spend the whole budget inside the 200-topic cluster
    // and the reviewer would never see the other two groups exist.
    const lopsided = fakeRegistry([
      ...Array.from({ length: 200 }, (_, i) =>
        fakeRecord({ slug: `big-${i}`, clusters: ['huge'], memberCount: 200 - i }),
      ),
      fakeRecord({ slug: 'small-one', clusters: ['tiny'], memberCount: 3 }),
      fakeRecord({ slug: 'no-cluster-yet', memberCount: 1 }),
    ]);
    const out = vocabularyForPrompt(lopsided, { maxChars: 120 });
    expect(out.length).toBeLessThanOrEqual(120);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]!.startsWith('huge (200): big-0')).toBe(true);
    expect(lines[1]).toBe('tiny (1): small-one');
    expect(lines[2]).toBe('(unclustered) (1): no-cluster-yet');
  });

  it('ranks the unclustered pile by its own size, so a large one leads', () => {
    // 57% of live sources are uncategorized precisely because the reviewer
    // could not see this pile; at any budget it must not be the first thing cut.
    const mostlyLoose = fakeRegistry([
      fakeRecord({ slug: 'clustered-a', clusters: ['ai-ml'], memberCount: 9 }),
      fakeRecord({ slug: 'loose-1', memberCount: 5 }),
      fakeRecord({ slug: 'loose-2', memberCount: 4 }),
    ]);
    const out = vocabularyForPrompt(mostlyLoose, { maxChars: 1000 });
    expect(out.split('\n')[0]).toBe('(unclustered) (2): loose-1, loose-2');
    expect(out.split('\n')[1]).toBe('ai-ml (1): clustered-a');
  });

  it('keeps real clusters ahead of the unclustered pile on a size tie', () => {
    expect(vocabularyForPrompt(reg, { maxChars: 1000 }).split('\n').slice(1)).toEqual([
      'physics (1): quantum-sensing',
      '(unclustered) (1): loose-topic',
    ]);
  });

  it('drops whole groups from the tail of the ranking when the budget is tiny', () => {
    const out = vocabularyForPrompt(reg, { maxChars: 40 });
    expect(out).toBe('ai-ml (3): llm-tool-use (+2 more)');
  });

  it('returns empty string for a non-positive budget or empty registry', () => {
    expect(vocabularyForPrompt(reg, { maxChars: 0 })).toBe('');
    expect(vocabularyForPrompt(reg, { maxChars: -5 })).toBe('');
    expect(vocabularyForPrompt(fakeRegistry([]), { maxChars: 100 })).toBe('');
  });

  it('is deterministic', () => {
    expect(vocabularyForPrompt(reg, { maxChars: 60 })).toBe(vocabularyForPrompt(reg, { maxChars: 60 }));
  });
});

describe('isKnownSlug', () => {
  const reg = fakeRegistry([fakeRecord({ slug: 'agent-memory' }), fakeRecord({ slug: 'rlhf' })]);

  it('recognizes an exact slug', () => {
    expect(isKnownSlug(reg, 'agent-memory')).toBe(true);
  });

  it('rejects an unknown slug', () => {
    expect(isKnownSlug(reg, 'agent-memories')).toBe(false);
  });

  it('normalizes case and separators before comparing', () => {
    expect(isKnownSlug(reg, 'Agent Memory')).toBe(true);
    expect(isKnownSlug(reg, 'agent_memory')).toBe(true);
    expect(isKnownSlug(reg, '  agent--memory  ')).toBe(true);
  });

  it('is false on an empty registry', () => {
    expect(isKnownSlug(fakeRegistry([]), 'anything')).toBe(false);
  });
});

describe('nearestSlugs', () => {
  const reg = fakeRegistry([
    fakeRecord({ slug: 'agent-memory' }),
    fakeRecord({ slug: 'agent-benchmarks' }),
    fakeRecord({ slug: 'quantum-sensing' }),
    fakeRecord({ slug: 'llm-tool-use' }),
  ]);

  it('corrects plural drift', () => {
    expect(nearestSlugs(reg, 'agent-memories', 1)).toEqual(['agent-memory']);
  });

  it('corrects a typo', () => {
    expect(nearestSlugs(reg, 'quantum-sensng', 1)).toEqual(['quantum-sensing']);
  });

  it('finds reordered tokens that edit distance alone would miss', () => {
    expect(nearestSlugs(reg, 'memory-agent', 1)).toEqual(['agent-memory']);
  });

  it('returns at most n candidates, best first', () => {
    const out = nearestSlugs(reg, 'agent-memory', 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('agent-memory');
  });

  it('returns nothing for a genuinely new topic', () => {
    expect(nearestSlugs(reg, 'perovskite-photovoltaics', 3)).toEqual([]);
  });

  it('returns nothing for n <= 0 or an empty slug', () => {
    expect(nearestSlugs(reg, 'agent-memory', 0)).toEqual([]);
    expect(nearestSlugs(reg, '', 3)).toEqual([]);
    expect(nearestSlugs(reg, '---', 3)).toEqual([]);
  });

  it('is deterministic under ties', () => {
    const tied = fakeRegistry([fakeRecord({ slug: 'aaa-x' }), fakeRecord({ slug: 'aaa-y' })]);
    expect(nearestSlugs(tied, 'aaa-z', 2)).toEqual(nearestSlugs(tied, 'aaa-z', 2));
    expect(nearestSlugs(tied, 'aaa-z', 1)).toEqual(['aaa-x']);
  });
});

describe('scan → render round trip', () => {
  it('renders a scanned vault into both formats without touching the vault', () => {
    source('arxiv-1', '---\ncited_by: 2\n---\n\n# One\n');
    topic(
      'agent-memory',
      canonicalTopic('Agent Memory', {
        clusters: ['ai-ml'],
        definition: 'Persistent state for agents.',
        members: ['arxiv-1'],
      }),
    );
    topic('loose', canonicalTopic('Loose', { definition: 'No cluster yet.' }));

    const reg = scanTopicRegistry(dir, AT);
    const md = renderRegistryMarkdown(reg);
    const json = JSON.parse(renderRegistryJson(reg));

    expect(md).toContain('### ai-ml (1)');
    expect(md).toContain('- [[wiki/topics/agent-memory]] — 1 sources, 2 citations');
    expect(md).toContain('1 topics have no cluster assigned.');
    expect(json.topics.find((t: { slug: string }) => t.slug === 'loose').oneLiner).toBe(
      'No cluster yet.',
    );
    expect(vocabularyForPrompt(reg, { maxChars: 200 })).toBe(
      'ai-ml (1): agent-memory\n(unclustered) (1): loose',
    );
  });
});

import { describe, it, expect } from 'vitest';

import {
  buildVaultGraph,
  renderGraphJson,
  clusterNodeId,
  entityNodeId,
  sourceNodeId,
  topicNodeId,
  type GraphInput,
  type GraphSourceInput,
  type GraphTopicInput,
} from '../src/shared/graph-export.js';

const AT = '2026-08-02T00:15:00.000Z';

function src(name: string, over: Partial<GraphSourceInput> = {}): GraphSourceInput {
  return {
    name,
    title: `Title of ${name}`,
    cites: [],
    related: [],
    entities: [],
    rigor: null,
    citedBy: 0,
    ...over,
  };
}

function topic(slug: string, over: Partial<GraphTopicInput> = {}): GraphTopicInput {
  return {
    slug,
    title: slug,
    clusters: [],
    members: [],
    relatedTopics: [],
    ...over,
  };
}

function input(over: Partial<GraphInput> = {}): GraphInput {
  return { generatedAt: AT, sources: [], topics: [], entities: [], ...over };
}

describe('buildVaultGraph', () => {
  it('emits a node per source, topic, entity, and distinct cluster', () => {
    const graph = buildVaultGraph(
      input({
        sources: [src('arxiv-1'), src('arxiv-2')],
        topics: [topic('cosmology', { clusters: ['physics'] }), topic('agents', { clusters: ['ai-ml'] })],
        entities: ['deepmind'],
      }),
    );

    expect(graph.stats).toEqual({
      nodes: 7,
      edges: 2,
      sources: 2,
      topics: 2,
      clusters: 2,
      entities: 1,
    });
    expect(graph.nodes.map((n) => n.id)).toEqual([
      clusterNodeId('ai-ml'),
      clusterNodeId('physics'),
      topicNodeId('agents'),
      topicNodeId('cosmology'),
      sourceNodeId('arxiv-1'),
      sourceNodeId('arxiv-2'),
      entityNodeId('deepmind'),
    ]);
  });

  it('carries the primary cluster on the topic node and one member edge per cluster', () => {
    const graph = buildVaultGraph(
      input({ topics: [topic('quantum-sensing', { clusters: ['physics', 'hardware'] })] }),
    );

    const node = graph.nodes.find((n) => n.id === topicNodeId('quantum-sensing'))!;
    expect(node.cluster).toBe('physics');
    expect(graph.edges).toEqual([
      { from: clusterNodeId('hardware'), to: topicNodeId('quantum-sensing'), type: 'member' },
      { from: clusterNodeId('physics'), to: topicNodeId('quantum-sensing'), type: 'member' },
    ]);
  });

  it('emits member, cites, related, and mentions edges', () => {
    const graph = buildVaultGraph(
      input({
        sources: [
          src('a', { cites: ['b'], related: ['c'], entities: ['deepmind'] }),
          src('b'),
          src('c'),
        ],
        topics: [topic('t1', { members: ['a', 'b'], relatedTopics: ['t2'] }), topic('t2')],
        entities: ['deepmind'],
      }),
    );

    // Sorted by (from, edge type, to) — `wiki/sources/…` before `wiki/topics/…`.
    expect(graph.edges).toEqual([
      { from: sourceNodeId('a'), to: sourceNodeId('b'), type: 'cites' },
      { from: sourceNodeId('a'), to: sourceNodeId('c'), type: 'related' },
      { from: sourceNodeId('a'), to: entityNodeId('deepmind'), type: 'mentions' },
      { from: topicNodeId('t1'), to: sourceNodeId('a'), type: 'member' },
      { from: topicNodeId('t1'), to: sourceNodeId('b'), type: 'member' },
      { from: topicNodeId('t1'), to: topicNodeId('t2'), type: 'related' },
    ]);
  });

  it('drops edges whose target has no node — a dangling ref is a broken link, not an edge', () => {
    const graph = buildVaultGraph(
      input({
        sources: [src('a', { cites: ['ghost'], entities: ['missing-entity'] })],
        topics: [topic('t1', { members: ['ghost'], relatedTopics: ['no-such-topic'] })],
      }),
    );

    expect(graph.edges).toEqual([]);
  });

  it('drops self-edges', () => {
    const graph = buildVaultGraph({
      ...input(),
      sources: [src('a', { cites: ['a'], related: ['a'] })],
    });
    expect(graph.edges).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    const graph = buildVaultGraph(
      input({
        sources: [src('a', { cites: ['b', 'b'] }), src('b')],
        topics: [topic('t', { members: ['a', 'a'] })],
      }),
    );
    expect(graph.edges.filter((e) => e.type === 'cites')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.type === 'member')).toHaveLength(1);
  });

  it('records importance only where a signal exists', () => {
    const graph = buildVaultGraph(
      input({
        sources: [
          src('scored', { rigor: 4, citedBy: 3 }),
          src('unscored'),
          src('cited-only', { citedBy: 2 }),
        ],
      }),
    );

    const by = (id: string) => graph.nodes.find((n) => n.id === id)!;
    expect(by(sourceNodeId('scored')).importance).toEqual({ rigor: 4, citedBy: 3 });
    expect(by(sourceNodeId('unscored')).importance).toBeUndefined();
    expect(by(sourceNodeId('cited-only')).importance).toEqual({ citedBy: 2 });
  });

  it('rolls member citations up onto the topic node', () => {
    const graph = buildVaultGraph(
      input({
        sources: [src('a', { citedBy: 3 }), src('b', { citedBy: 4 }), src('c')],
        topics: [topic('hot', { members: ['a', 'b'] }), topic('cold', { members: ['c'] })],
      }),
    );

    expect(graph.nodes.find((n) => n.id === topicNodeId('hot'))!.importance).toEqual({ citedBy: 7 });
    expect(graph.nodes.find((n) => n.id === topicNodeId('cold'))!.importance).toBeUndefined();
  });

  it('is order-independent: shuffled input yields byte-identical JSON', () => {
    const sources = [src('c', { cites: ['a'] }), src('a'), src('b', { cites: ['a'] })];
    const topics = [
      topic('z', { clusters: ['physics'], members: ['b'] }),
      topic('a', { clusters: ['ai-ml'], members: ['c', 'a'] }),
    ];
    const one = renderGraphJson(
      buildVaultGraph(input({ sources, topics, entities: ['x', 'deepmind'] })),
    );
    const two = renderGraphJson(
      buildVaultGraph(
        input({
          sources: [...sources].reverse(),
          topics: [...topics].reverse(),
          entities: ['deepmind', 'x'],
        }),
      ),
    );
    expect(one).toBe(two);
  });
});

describe('renderGraphJson', () => {
  it('round-trips through JSON.parse', () => {
    const graph = buildVaultGraph(
      input({
        sources: [src('a', { cites: ['b'], rigor: 5, citedBy: 1 }), src('b')],
        topics: [topic('t', { clusters: ['ai-ml'], members: ['a'] })],
        entities: ['deepmind'],
      }),
    );
    expect(JSON.parse(renderGraphJson(graph))).toEqual(graph);
  });

  it('keeps one record per line so vault diffs stay proportional to the change', () => {
    const graph = buildVaultGraph(input({ sources: [src('a'), src('b'), src('c')] }));
    const lines = renderGraphJson(graph).split('\n');
    const nodeLines = lines.filter((l) => l.trimStart().startsWith('{"id"'));
    expect(nodeLines).toHaveLength(3);
    expect(nodeLines[0]!.trim().endsWith(',')).toBe(true);
    expect(nodeLines[2]!.trim().endsWith('}')).toBe(true);
  });
});

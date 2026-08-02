import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import {
  CLUSTER_ALIASES,
  MAX_CLUSTERS_PER_TOPIC,
  allowedClusterLabels,
  applyAssignments,
  buildBatchUserMessage,
  buildSystemPrompt,
  chunk,
  classifyBatch,
  makeClusterAgentFn,
  normalizeClusterLabel,
  runBackfill,
  resolveAssignments,
  unclusteredTopics,
  validateAssignments,
  type ClusterAgentFn,
} from '../scripts/backfill-clusters-llm.js';
import { scanTopicRegistry, type TopicRecord, type TopicRegistry } from '../src/shared/topic-registry.js';

// ---- fixtures -------------------------------------------------------------

function topic(slug: string, overrides: Partial<TopicRecord> = {}): TopicRecord {
  return {
    slug,
    title: slug,
    oneLiner: `About ${slug}.`,
    clusters: [],
    memberCount: 0,
    citedByTotal: 0,
    updated: null,
    ...overrides,
  };
}

function registry(topics: TopicRecord[]): TopicRegistry {
  const counts = new Map<string, number>();
  for (const t of topics) for (const c of new Set(t.clusters)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const clusters: Record<string, { topicCount: number }> = {};
  for (const name of [...counts.keys()].sort()) clusters[name] = { topicCount: counts.get(name)! };
  return { topics, clusters, generatedAt: '2026-08-02T00:00:00Z' };
}

const ALLOWED = ['ai-ml', 'physics', 'biology', 'cybersecurity', 'aerospace'];

/** An agentFn that answers from a fixed slug → clusters table. */
function tableAgent(
  table: Record<string, string[]>,
  seen?: { systems: string[]; users: string[] },
): ClusterAgentFn {
  return async (systemPrompt, userMessage) => {
    seen?.systems.push(systemPrompt);
    seen?.users.push(userMessage);
    const slugs = [...userMessage.matchAll(/^- slug: (.+)$/gm)].map((m) => m[1]!);
    return {
      text: JSON.stringify({
        assignments: slugs.map((slug) => ({ slug, clusters: table[slug] ?? [] })),
      }),
      finishReason: 'stop',
    };
  };
}

// ---- vault fixture (real files, so writes are observable) -----------------

let dir: string;
let topicsDir: string;

function page(slug: string, clusters?: string[]): string {
  const fm = ['---', 'type: topic', 'status: active', 'created: 2026-01-01', 'updated: 2026-07-01'];
  if (clusters) fm.push(`clusters: [${clusters.join(', ')}]`);
  fm.push('related_topics: []', '---');
  return `${fm.join('\n')}\n\n# ${slug}\n\nA definition of ${slug}.\n\n## Member sources\n\n_None yet._\n`;
}

function writePage(slug: string, clusters?: string[]): void {
  writeFileSync(join(topicsDir, `${slug}.md`), page(slug, clusters));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-backfill-clusters-llm-'));
  topicsDir = join(dir, 'wiki', 'topics');
  mkdirSync(topicsDir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---- vocabulary -----------------------------------------------------------

describe('normalizeClusterLabel', () => {
  it('applies the canonical alias map', () => {
    expect(normalizeClusterLabel('bio')).toBe('biology');
    expect(normalizeClusterLabel('security')).toBe('cybersecurity');
    expect(normalizeClusterLabel('space')).toBe('aerospace');
  });

  it('normalizes case, whitespace and underscores before aliasing', () => {
    expect(normalizeClusterLabel('  Security ')).toBe('cybersecurity');
    expect(normalizeClusterLabel('AI_ML')).toBe('ai-ml');
    expect(normalizeClusterLabel('Signal Processing')).toBe('signal-processing');
  });

  it('leaves unaliased names alone and yields empty for junk', () => {
    expect(normalizeClusterLabel('physics')).toBe('physics');
    expect(normalizeClusterLabel('   ')).toBe('');
    expect(normalizeClusterLabel('***')).toBe('');
  });

  it('keeps the alias map small and one-way (no canonical name is itself an alias)', () => {
    for (const target of Object.values(CLUSTER_ALIASES)) {
      expect(CLUSTER_ALIASES[target]).toBeUndefined();
    }
  });
});

describe('allowedClusterLabels', () => {
  it('collapses aliased names into their canonical form and sums their counts', () => {
    const reg = registry([
      topic('a', { clusters: ['cybersecurity'] }),
      topic('b', { clusters: ['cybersecurity'] }),
      topic('c', { clusters: ['security'] }),
      topic('d', { clusters: ['physics'] }),
    ]);
    const allowed = allowedClusterLabels(reg);
    expect(allowed).not.toContain('security');
    // 2 + 1 canonicalized beats physics' 1.
    expect(allowed).toEqual(['cybersecurity', 'physics']);
  });

  it('orders by topic count desc, then name asc', () => {
    const reg = registry([
      topic('a', { clusters: ['ai-ml'] }),
      topic('b', { clusters: ['ai-ml'] }),
      topic('c', { clusters: ['ai-ml'] }),
      topic('d', { clusters: ['zebra'] }),
      topic('e', { clusters: ['alpha'] }),
    ]);
    expect(allowedClusterLabels(reg)).toEqual(['ai-ml', 'alpha', 'zebra']);
  });

  it('is empty for a vault with no clusters at all', () => {
    expect(allowedClusterLabels(registry([topic('a'), topic('b')]))).toEqual([]);
  });
});

describe('unclusteredTopics', () => {
  it('selects only topics with no clusters, most-connected first', () => {
    const reg = registry([
      topic('small', { memberCount: 1 }),
      topic('clustered', { clusters: ['ai-ml'], memberCount: 99 }),
      topic('big', { memberCount: 40 }),
      topic('tie-b', { memberCount: 1, citedByTotal: 5 }),
    ]);
    expect(unclusteredTopics(reg).map((t) => t.slug)).toEqual(['big', 'tie-b', 'small']);
  });
});

// ---- batching -------------------------------------------------------------

describe('chunk', () => {
  it('splits into full batches plus a remainder', () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('returns no batches for no items', () => {
    expect(chunk([], 30)).toEqual([]);
  });

  it('never produces a zero-sized batch (which would loop forever)', () => {
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('runBackfill batching', () => {
  it('makes one call per batch and covers every target exactly once', async () => {
    const targets = Array.from({ length: 7 }, (_, i) => topic(`t${i}`));
    for (const t of targets) writePage(t.slug);
    const seen = { systems: [] as string[], users: [] as string[] };

    const summary = await runBackfill({
      topicsDir,
      targets,
      allowed: ALLOWED,
      batchSize: 3,
      execute: false,
      agentFn: tableAgent({}, seen),
      log: () => {},
    });

    expect(summary.batches).toBe(3);
    expect(seen.users).toHaveLength(3);
    const slugsSent = seen.users.flatMap((u) => [...u.matchAll(/^- slug: (.+)$/gm)].map((m) => m[1]!));
    expect(slugsSent.sort()).toEqual(targets.map((t) => t.slug).sort());
  });

  it('sends the topic definition and the allowed vocabulary to the model', async () => {
    const seen = { systems: [] as string[], users: [] as string[] };
    await runBackfill({
      topicsDir,
      targets: [topic('quantum-sensing', { title: 'Quantum sensing', oneLiner: 'Sensors using quantum states.' })],
      allowed: ALLOWED,
      batchSize: 30,
      execute: false,
      agentFn: tableAgent({}, seen),
      log: () => {},
    });
    expect(seen.users[0]).toContain('slug: quantum-sensing');
    expect(seen.users[0]).toContain('title: Quantum sensing');
    expect(seen.users[0]).toContain('definition: Sensors using quantum states.');
    for (const label of ALLOWED) expect(seen.systems[0]).toContain(label);
  });
});

describe('prompt construction', () => {
  it('states the allowed list and the empty-is-fine rule', () => {
    const prompt = buildSystemPrompt(ALLOWED);
    expect(prompt).toContain(ALLOWED.join(', '));
    expect(prompt).toMatch(/NEVER invent/);
    expect(prompt).toMatch(/empty array/);
  });

  it('renders a placeholder for a topic with no definition', () => {
    expect(buildBatchUserMessage([topic('bare', { oneLiner: null })])).toContain('definition: (none)');
  });
});

// ---- validation -----------------------------------------------------------

describe('validateAssignments', () => {
  it('accepts the documented shape', () => {
    const r = validateAssignments({ assignments: [{ slug: 'a', clusters: ['ai-ml'] }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ slug: 'a', clusters: ['ai-ml'] }]);
  });

  it('rejects non-objects and a missing assignments array', () => {
    expect(validateAssignments(['a']).ok).toBe(false);
    expect(validateAssignments({}).ok).toBe(false);
    expect(validateAssignments({ assignments: 'ai-ml' }).ok).toBe(false);
  });

  it('drops malformed entries rather than failing the whole batch', () => {
    const r = validateAssignments({
      assignments: [null, { slug: '' }, { clusters: ['ai-ml'] }, { slug: 'ok', clusters: ['ai-ml', 7] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ slug: 'ok', clusters: ['ai-ml'] }]);
  });
});

describe('resolveAssignments', () => {
  const batch = [topic('a'), topic('b')];

  it('drops unknown labels and counts them', () => {
    const r = resolveAssignments(batch, [{ slug: 'a', clusters: ['ai-ml', 'underwater-basket-weaving'] }], ALLOWED);
    expect(r.assignments).toEqual([{ slug: 'a', clusters: ['ai-ml'] }]);
    expect(r.droppedLabels).toEqual(['underwater-basket-weaving']);
  });

  it('applies the normalization map before checking the allowed set', () => {
    const r = resolveAssignments(
      batch,
      [
        { slug: 'a', clusters: ['Security'] },
        { slug: 'b', clusters: ['space', 'bio'] },
      ],
      ALLOWED,
    );
    expect(r.assignments).toEqual([
      { slug: 'a', clusters: ['cybersecurity'] },
      { slug: 'b', clusters: ['aerospace', 'biology'] },
    ]);
    expect(r.droppedLabels).toEqual([]);
  });

  it('omits topics the model left empty — no cluster is a valid answer', () => {
    const r = resolveAssignments(batch, [{ slug: 'a', clusters: [] }, { slug: 'b', clusters: ['physics'] }], ALLOWED);
    expect(r.assignments).toEqual([{ slug: 'b', clusters: ['physics'] }]);
    expect(r.droppedLabels).toEqual([]);
  });

  it(`caps at ${MAX_CLUSTERS_PER_TOPIC} clusters and dedupes after normalization`, () => {
    const r = resolveAssignments(
      batch,
      [{ slug: 'a', clusters: ['ai-ml', 'physics', 'biology'] }, { slug: 'b', clusters: ['security', 'cybersecurity'] }],
      ALLOWED,
    );
    expect(r.assignments).toEqual([
      { slug: 'a', clusters: ['ai-ml', 'physics'] },
      { slug: 'b', clusters: ['cybersecurity'] },
    ]);
    expect(r.droppedLabels).toEqual(['biology']);
  });

  it('drops slugs that were not in the batch, and repeats of one that was', () => {
    const r = resolveAssignments(
      batch,
      [{ slug: 'ghost', clusters: ['ai-ml'] }, { slug: 'a', clusters: ['ai-ml'] }, { slug: 'a', clusters: ['physics'] }],
      ALLOWED,
    );
    expect(r.assignments).toEqual([{ slug: 'a', clusters: ['ai-ml'] }]);
    expect(r.droppedSlugs).toEqual(['ghost', 'a']);
  });

  it('returns assignments in batch order, not the order the model answered in', () => {
    const r = resolveAssignments(
      batch,
      [{ slug: 'b', clusters: ['physics'] }, { slug: 'a', clusters: ['ai-ml'] }],
      ALLOWED,
    );
    expect(r.assignments.map((a) => a.slug)).toEqual(['a', 'b']);
  });
});

// ---- per-batch failure handling -------------------------------------------

describe('classifyBatch', () => {
  const batch = [topic('a')];

  it('round-trips a well-formed answer', async () => {
    const r = await classifyBatch(batch, ALLOWED, tableAgent({ a: ['ai-ml'] }));
    expect(r.ok).toBe(true);
    expect(r.assignments).toEqual([{ slug: 'a', clusters: ['ai-ml'] }]);
  });

  it('fails the batch on truncation rather than trusting a partial answer', async () => {
    const r = await classifyBatch(batch, ALLOWED, async () => ({
      text: '{"assignments": [{"slug": "a", "clus',
      finishReason: 'length',
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('truncated');
    expect(r.assignments).toEqual([]);
  });

  it('fails the batch when the agent reports an error', async () => {
    const r = await classifyBatch(batch, ALLOWED, async () => ({ text: '', finishReason: 'error' }));
    expect(r).toMatchObject({ ok: false, reason: 'agent-error' });
  });

  it('turns a thrown transport error into a failed batch, not a thrown run', async () => {
    const r = await classifyBatch(batch, ALLOWED, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ECONNREFUSED');
  });

  it('fails the batch on unparseable output', async () => {
    const r = await classifyBatch(batch, ALLOWED, async () => ({ text: 'sure! here you go', finishReason: 'stop' }));
    expect(r).toMatchObject({ ok: false, reason: 'parse-failed' });
  });

  it('fails the batch on valid JSON of the wrong shape', async () => {
    const r = await classifyBatch(batch, ALLOWED, async () => ({ text: '{"topics": []}', finishReason: 'stop' }));
    expect(r).toMatchObject({ ok: false, reason: 'assignments-not-an-array' });
  });
});

// ---- writing --------------------------------------------------------------

describe('applyAssignments', () => {
  it('injects clusters into a page that has none', () => {
    writePage('agent-memory');
    const r = applyAssignments(topicsDir, [{ slug: 'agent-memory', clusters: ['ai-ml'] }]);
    expect(r).toEqual({ written: 1, skippedUnchanged: 0, missing: 0 });
    expect(readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8')).toContain('clusters: [ai-ml]');
  });

  it('never rewrites a page that already carries a clusters key', () => {
    writePage('agent-memory', ['physics']);
    const before = readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8');
    const r = applyAssignments(topicsDir, [{ slug: 'agent-memory', clusters: ['ai-ml'] }]);
    expect(r).toEqual({ written: 0, skippedUnchanged: 1, missing: 0 });
    expect(readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8')).toBe(before);
  });

  it('counts a missing page instead of throwing', () => {
    const r = applyAssignments(topicsDir, [{ slug: 'vanished', clusters: ['ai-ml'] }]);
    expect(r).toEqual({ written: 0, skippedUnchanged: 0, missing: 1 });
  });

  it('leaves the rest of the page byte-identical', () => {
    writePage('agent-memory');
    const before = readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8');
    applyAssignments(topicsDir, [{ slug: 'agent-memory', clusters: ['ai-ml'] }]);
    const after = readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8');
    expect(after.replace('clusters: [ai-ml]\n', '')).toBe(before);
  });
});

// ---- run-level behaviour --------------------------------------------------

describe('runBackfill', () => {
  it('dry run touches nothing on disk', async () => {
    writePage('agent-memory');
    const path = join(topicsDir, 'agent-memory.md');
    const before = readFileSync(path, 'utf8');
    const mtimeBefore = statSync(path).mtimeMs;

    const summary = await runBackfill({
      topicsDir,
      targets: [topic('agent-memory')],
      allowed: ALLOWED,
      batchSize: 30,
      execute: false,
      agentFn: tableAgent({ 'agent-memory': ['ai-ml'] }),
      log: () => {},
    });

    expect(summary.mode).toBe('dry-run');
    expect(summary.topicsAssigned).toBe(1);
    expect(summary.pagesWritten).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
  });

  it('writes assignments under --execute and reports a histogram', async () => {
    for (const slug of ['agent-memory', 'quantum-sensing', 'ion-thrusters', 'nothing-fits']) writePage(slug);

    const summary = await runBackfill({
      topicsDir,
      targets: ['agent-memory', 'quantum-sensing', 'ion-thrusters', 'nothing-fits'].map((s) => topic(s)),
      allowed: ALLOWED,
      batchSize: 2,
      execute: true,
      agentFn: tableAgent({
        'agent-memory': ['ai-ml'],
        'quantum-sensing': ['physics', 'ai-ml'],
        'ion-thrusters': ['space'],
        'nothing-fits': [],
      }),
      log: () => {},
    });

    expect(summary.topicsAssigned).toBe(3);
    expect(summary.topicsUnassigned).toBe(1);
    expect(summary.pagesWritten).toBe(3);
    // Ordered by count desc, name asc; 'space' arrives canonicalized.
    expect(Object.entries(summary.histogram)).toEqual([
      ['ai-ml', 2],
      ['aerospace', 1],
      ['physics', 1],
    ]);
    expect(readFileSync(join(topicsDir, 'ion-thrusters.md'), 'utf8')).toContain('clusters: [aerospace]');
    expect(readFileSync(join(topicsDir, 'nothing-fits.md'), 'utf8')).not.toContain('clusters:');
  });

  it('is idempotent: a second execute run writes nothing', async () => {
    writePage('agent-memory');
    const opts = {
      topicsDir,
      targets: [topic('agent-memory')],
      allowed: ALLOWED,
      batchSize: 30,
      execute: true,
      // A rerun would propose a different cluster; only-if-empty must win.
      agentFn: tableAgent({ 'agent-memory': ['physics'] }),
      log: () => {},
    };

    const first = await runBackfill({ ...opts, agentFn: tableAgent({ 'agent-memory': ['ai-ml'] }) });
    expect(first.pagesWritten).toBe(1);
    const afterFirst = readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8');

    const second = await runBackfill(opts);
    expect(second.pagesWritten).toBe(0);
    expect(second.pagesSkippedUnchanged).toBe(1);
    expect(readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8')).toBe(afterFirst);
  });

  it('skips a failing batch and keeps going', async () => {
    for (const slug of ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']) writePage(slug);
    let call = 0;
    const flaky: ClusterAgentFn = async (system, user) => {
      call++;
      if (call === 2) throw new Error('502 Bad Gateway');
      return tableAgent({ a1: ['ai-ml'], a2: ['ai-ml'], b1: ['physics'], b2: ['physics'], c1: ['biology'], c2: ['biology'] })(
        system,
        user,
      );
    };

    const summary = await runBackfill({
      topicsDir,
      targets: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map((s) => topic(s)),
      allowed: ALLOWED,
      batchSize: 2,
      execute: true,
      agentFn: flaky,
      log: () => {},
    });

    expect(summary.batches).toBe(3);
    expect(summary.batchesFailed).toBe(1);
    expect(summary.failures[0]).toContain('batch 2');
    expect(summary.topicsAssigned).toBe(4);
    expect(summary.pagesWritten).toBe(4);
    // The skipped batch's pages keep their empty frontmatter, ready for a re-run.
    expect(readFileSync(join(topicsDir, 'b1.md'), 'utf8')).not.toContain('clusters:');
    expect(readFileSync(join(topicsDir, 'a1.md'), 'utf8')).toContain('clusters: [ai-ml]');
  });

  it('counts dropped labels across the whole run', async () => {
    writePage('a');
    const summary = await runBackfill({
      topicsDir,
      targets: [topic('a')],
      allowed: ALLOWED,
      batchSize: 30,
      execute: false,
      agentFn: tableAgent({ a: ['ai-ml', 'made-up-cluster'] }),
      log: () => {},
    });
    expect(summary.labelsDropped).toBe(1);
    expect(summary.topicsAssigned).toBe(1);
  });

  it('survives a run where every batch fails, writing nothing', async () => {
    writePage('a');
    const summary = await runBackfill({
      topicsDir,
      targets: [topic('a')],
      allowed: ALLOWED,
      batchSize: 30,
      execute: true,
      agentFn: async () => {
        throw new Error('down');
      },
      log: () => {},
    });
    expect(summary.batchesFailed).toBe(1);
    expect(summary.pagesWritten).toBe(0);
    expect(readFileSync(join(topicsDir, 'a.md'), 'utf8')).not.toContain('clusters:');
  });
});

// ---- end-to-end over a scanned vault --------------------------------------

describe('scan → backfill round trip with a fake inference client', () => {
  function fakeStreamingClient(text: string, finishReason: string = 'stop'): OpenAI {
    const chunks = [
      { choices: [{ delta: { content: text }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: finishReason, index: 0 }] },
    ];
    const stream = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i < chunks.length) return { value: chunks[i++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    return { chat: { completions: { create: async () => stream } } } as unknown as OpenAI;
  }

  it('clusters exactly the unclustered pages the registry scan reports', async () => {
    writePage('agent-memory');
    writePage('quantum-sensing');
    writePage('already-done', ['physics']);
    writeFileSync(join(topicsDir, '_registry.md'), '# generated, not a topic\n');

    const reg = scanTopicRegistry(dir, '2026-08-02T00:00:00Z');
    const targets = unclusteredTopics(reg);
    expect(targets.map((t) => t.slug).sort()).toEqual(['agent-memory', 'quantum-sensing']);
    expect(allowedClusterLabels(reg)).toEqual(['physics']);

    const client = fakeStreamingClient(
      JSON.stringify({
        assignments: [
          { slug: 'agent-memory', clusters: ['ai-ml'] }, // not in this vault's vocabulary
          { slug: 'quantum-sensing', clusters: ['Physics'] },
        ],
      }),
    );

    const summary = await runBackfill({
      topicsDir,
      targets,
      allowed: allowedClusterLabels(reg),
      batchSize: 30,
      execute: true,
      agentFn: makeClusterAgentFn(client, 'fake-model'),
      log: () => {},
    });

    expect(summary.labelsDropped).toBe(1);
    expect(summary.pagesWritten).toBe(1);
    expect(readFileSync(join(topicsDir, 'quantum-sensing.md'), 'utf8')).toContain('clusters: [physics]');
    expect(readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8')).not.toContain('clusters:');
    // The generated artifact is never a target and is never written.
    expect(readFileSync(join(topicsDir, '_registry.md'), 'utf8')).toBe('# generated, not a topic\n');
  });

  it('skips the batch when the fake client truncates mid-JSON', async () => {
    writePage('agent-memory');
    const reg = scanTopicRegistry(dir, '2026-08-02T00:00:00Z');
    const client = fakeStreamingClient('{"assignments": [{"slug": "agent-mem', 'length');

    const summary = await runBackfill({
      topicsDir,
      targets: unclusteredTopics(reg),
      allowed: ALLOWED,
      batchSize: 30,
      execute: true,
      agentFn: makeClusterAgentFn(client, 'fake-model'),
      log: () => {},
    });

    expect(summary.batchesFailed).toBe(1);
    expect(summary.pagesWritten).toBe(0);
    expect(readFileSync(join(topicsDir, 'agent-memory.md'), 'utf8')).not.toContain('clusters:');
  });
});

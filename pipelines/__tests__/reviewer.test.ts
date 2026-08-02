import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import {
  applyReconcileAndGate,
  buildReviewerSystemPrompt,
  isReviewerFailureReason,
  reviewerFailureAttempts,
  reviewerFailureReason,
  runReviewerWith,
  REVIEWER_VOCABULARY_HEADING,
  type ReviewerAgentFn,
  type ReviewerClients,
  type ReviewerInput,
  type ReviewerOutput,
} from '../src/phases/reviewer.js';
import { VaultFs } from '../src/tools/vault.js';
import type { ArticleRow } from '../src/shared/article-store.js';
import type { ScoutOutput } from '../src/phases/scouts/types.js';

const fakeClient = {} as OpenAI;
const clients: ReviewerClients = { client: fakeClient, model: 'fake-model' };

function makeArticle(): ArticleRow {
  return {
    id: 1,
    url: 'https://arxiv.org/abs/2605.03823',
    urlHash: 'h',
    title: 'A paper title',
    titleHash: 't',
    source: 'arXiv',
    field: 'AI/ML',
    snippet: 'snippet',
    collectedAt: new Date('2026-05-06T00:00:00Z'),
    collectedFrom: 'raw/inbox/x.md',
    status: 'pending',
    statusReason: null,
    processedAt: null,
    pagePaths: [],
  };
}

function emptyScout(): ScoutOutput {
  return { surfacedPages: [] };
}

function makeInput(overrides: Partial<ReviewerInput> = {}): ReviewerInput {
  return {
    article: makeArticle(),
    body: 'body',
    topicScout: emptyScout(),
    sourceScout: emptyScout(),
    entityScout: emptyScout(),
    citeTracker: emptyScout(),
    ...overrides,
  };
}

function makeVault(): { vault: VaultFs; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'chiya-rev-'));
  return { vault: new VaultFs(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('runReviewerWith — happy path', () => {
  it('parses valid JSON into the structured output', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => ({
        text: JSON.stringify({
          topics: [
            { slug: 'bayes-consistency', why: 'central concept' },
            { slug: 'metric-losses', why: 'extends to', isNew: true, definition: 'Loss functions defined over arbitrary metric spaces, used in classification beyond 0-1.' },
          ],
          cites: [{ filename: 'arxiv-2403-12345', why: 'foundational' }],
          related: [{ filename: 'arxiv-2604-25099', why: 'sibling' }],
          entities: [{ slug: 'bousquet', why: 'author of cited work' }],
        }),
        finishReason: 'stop',
        toolRounds: 2,
      });
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      expect(out.topics).toHaveLength(2);
      expect(out.topics[0]!.slug).toBe('bayes-consistency');
      expect(out.topics[1]!.isNew).toBe(true);
      expect(out.cites).toHaveLength(1);
      expect(out.related).toHaveLength(1);
      expect(out.entities).toHaveLength(1);
      expect(out.toolRounds).toBe(2);
      expect(out.error).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('summarizes scout findings into the user message', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const seen: string[] = [];
      const fakeAgent: ReviewerAgentFn = async (_sys, user) => {
        seen.push(user);
        return { text: '{"topics":[],"cites":[],"related":[],"entities":[]}', finishReason: 'stop', toolRounds: 0 };
      };
      await runReviewerWith(
        makeInput({
          topicScout: {
            surfacedPages: [
              { path: 'wiki/topics/llm-eval.md', excerpt: 'About LLM eval...', relevanceNote: 'core topic' },
            ],
          },
          citeTracker: { surfacedPages: [], error: 'truncated' },
        }),
        clients,
        vault,
        undefined,
        fakeAgent,
      );
      const msg = seen[0]!;
      expect(msg).toContain('topicScout surfaced 1');
      expect(msg).toContain('wiki/topics/llm-eval.md');
      expect(msg).toContain('citeTracker: error="truncated"');
    } finally {
      cleanup();
    }
  });
});

describe('runReviewerWith — failure modes', () => {
  it('returns error="truncated" without throwing on finishReason=length', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => ({ text: '{"topics":["partial', finishReason: 'length', toolRounds: 1 });
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      expect(out.error).toBe('truncated');
      expect(out.topics).toEqual([]);
      expect(out.toolRounds).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('returns error="parse-failed" on non-JSON output', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => ({ text: 'not json', finishReason: 'stop', toolRounds: 0 });
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      expect(out.error).toBe('parse-failed');
    } finally {
      cleanup();
    }
  });

  it('returns error from agent throw without crashing', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => { throw new Error('boom'); };
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      expect(out.error).toBe('boom');
    } finally {
      cleanup();
    }
  });

  it('drops malformed entries, caps lengths', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => ({
        text: JSON.stringify({
          topics: [
            { slug: 'good', why: 'real' },
            { slug: 'no-why' },                                      // missing why → drop
            { slug: 'new-without-def', why: 'x', isNew: true },      // isNew but no definition → drop
            { slug: 't1', why: 'a' }, { slug: 't2', why: 'b' }, { slug: 't3', why: 'c' }, { slug: 't4', why: 'd' }, // cap at 4
          ],
          cites: 'not-an-array',
          related: [],
          entities: null,
        }),
        finishReason: 'stop',
        toolRounds: 0,
      });
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      expect(out.topics).toHaveLength(4);
      expect(out.topics.map((t) => t.slug)).toEqual(['good', 't1', 't2', 't3']);
      expect(out.cites).toEqual([]);
      expect(out.entities).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('reviewer failure deferral bookkeeping', () => {
  it('round-trips the attempt marker through status_reason', () => {
    const reason = reviewerFailureReason(1, 'truncated');
    expect(reason).toBe('reviewer-failed (attempt 1): truncated');
    expect(isReviewerFailureReason(reason)).toBe(true);
    expect(reviewerFailureAttempts(reason)).toBe(1);
    expect(reviewerFailureAttempts(reviewerFailureReason(2, 'boom'))).toBe(2);
  });

  it('non-failure reasons parse as zero attempts', () => {
    expect(reviewerFailureAttempts(null)).toBe(0);
    expect(reviewerFailureAttempts('deadline-rolled-over')).toBe(0);
    expect(isReviewerFailureReason('deadline-rolled-over')).toBe(false);
    expect(isReviewerFailureReason(null)).toBe(false);
  });

  it('caps the persisted reason at 200 chars', () => {
    const reason = reviewerFailureReason(1, 'x'.repeat(500));
    expect(reason.length).toBe(200);
    expect(reviewerFailureAttempts(reason)).toBe(1);
  });
});

describe('applyReconcileAndGate', () => {
  const existingSlugs = new Set(['llm-evaluation', 'agent-benchmarks', 'transformers']);
  const sourceFiles = new Set(['arxiv-2403-12345', 'arxiv-2604-25099']);
  const sourceExists = (f: string) => sourceFiles.has(f);

  function reviewer(over: Partial<ReviewerOutput> = {}): ReviewerOutput {
    return {
      topics: [],
      cites: [],
      related: [],
      entities: [],
      ...over,
    };
  }

  it('passes through existing-topic slugs and existing cite/entity files', async () => {
    const r = reviewer({
      topics: [
        { slug: 'llm-evaluation', why: 'fits' },
        { slug: 'transformers', why: 'fits' },
      ],
      cites: [{ filename: 'arxiv-2403-12345', why: 'foundational' }],
      entities: [{ slug: 'anthropic', why: 'central' }],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.existingTopicSlugs).toEqual(['llm-evaluation', 'transformers']);
    expect(result.citeFilenames).toEqual(['arxiv-2403-12345']);
    expect(result.entities).toEqual([{ slug: 'anthropic', name: null, kind: null }]);
    expect(result.newTopicsToCreate).toEqual([]);
  });

  it('folds a false-new topic back to existing', async () => {
    const r = reviewer({
      topics: [
        {
          slug: 'llm-evaluation',
          why: 'fits',
          isNew: true,
          definition: 'A research area dealing with how to assess large language model capabilities.',
        },
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.existingTopicSlugs).toEqual(['llm-evaluation']);
    expect(result.newTopicsToCreate).toEqual([]);
    expect(result.gateStats.foldedSlugs).toBe(1);
  });

  it('creates a truly-new topic when it passes both gate checks', async () => {
    const r = reviewer({
      topics: [
        {
          slug: 'metric-losses',
          why: 'central',
          isNew: true,
          definition:
            'Loss functions defined over arbitrary metric spaces, used in classification settings beyond standard 0-1 loss.',
        },
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.newTopicsToCreate).toHaveLength(1);
    expect(result.newTopicsToCreate[0]!.slug).toBe('metric-losses');
    expect(result.existingTopicSlugs).toEqual(['metric-losses']);
  });

  it('snaps a near-duplicate new proposal onto the existing topic instead of dropping it', async () => {
    const r = reviewer({
      topics: [
        {
          slug: 'transformer',
          why: 'central',
          isNew: true,
          definition: 'A neural-network architecture based on attention mechanisms for sequence modeling.',
        },
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.newTopicsToCreate).toEqual([]);
    expect(result.gateStats.fuzzyCorrected).toBe(1);
    expect(result.existingTopicSlugs).toEqual(['transformers']);
  });

  it('still rejects a near-duplicate that the fuzzy matcher scores as unrelated', async () => {
    // 'ml' vs 'mlops' is a prefix-rule duplicate for the gate but falls under
    // nearestSlugs' similarity floor, so correction cannot reach it.
    const r = reviewer({
      topics: [
        {
          slug: 'mlops',
          why: 'central',
          isNew: true,
          definition: 'Operational practices for deploying and monitoring machine-learning systems in production.',
        },
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: new Set(['ml']),
      sourceExists,
    });
    expect(result.newTopicsToCreate).toEqual([]);
    expect(result.gateStats.fuzzyCorrected).toBe(0);
    expect(result.gateStats.rejectedNearDuplicates).toBe(1);
    expect(result.existingTopicSlugs).toEqual(['uncategorized']);
  });

  it('rejects a thin definition', async () => {
    const r = reviewer({
      topics: [
        { slug: 'novel-area', why: 'central', isNew: true, definition: 'AI stuff.' },
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.newTopicsToCreate).toEqual([]);
    expect(result.gateStats.rejectedThinDefinition).toBe(1);
    expect(result.existingTopicSlugs).toEqual(['uncategorized']);
  });

  it('falls back to "uncategorized" when no slugs survive', async () => {
    const r = reviewer({
      topics: [
        { slug: 'slug-not-in-existing', why: 'x' },          // hallucination, dropped
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.existingTopicSlugs).toEqual(['uncategorized']);
    expect(result.gateStats.droppedHallucinations).toBe(1);
  });

  it('drops cite filenames whose source pages do not exist', async () => {
    const r = reviewer({
      cites: [
        { filename: 'arxiv-2403-12345', why: 'exists' },
        { filename: 'arxiv-9999-99999', why: 'does not exist' },
      ],
    });
    const result = await applyReconcileAndGate({
      reviewer: r,
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.citeFilenames).toEqual(['arxiv-2403-12345']);
  });
});

describe('reviewer topic vocabulary injection', () => {
  const VOCAB = 'ai-ml (3): llm-evaluation, transformers (+1 more)\nphysics (1): quantum-sensing';

  it('injects the run vocabulary into the system prompt under the assign-to-these heading', async () => {
    const { vault, cleanup } = makeVault();
    try {
      let seenSystem = '';
      const fakeAgent: ReviewerAgentFn = async (system) => {
        seenSystem = system;
        return { text: '{"topics":[],"cites":[],"related":[],"entities":[]}', finishReason: 'stop', toolRounds: 0 };
      };
      await runReviewerWith(makeInput({ vocabulary: VOCAB }), clients, vault, undefined, fakeAgent);

      expect(seenSystem).toContain(REVIEWER_VOCABULARY_HEADING);
      expect(seenSystem).toContain('assign to these when applicable');
      expect(seenSystem).toContain('ai-ml (3): llm-evaluation, transformers');
      expect(seenSystem).toContain('quantum-sensing');
    } finally {
      cleanup();
    }
  });

  it('omits the vocabulary block entirely when no registry is available', () => {
    const bare = buildReviewerSystemPrompt(undefined);
    expect(bare).not.toContain(REVIEWER_VOCABULARY_HEADING);
    expect(buildReviewerSystemPrompt('   ')).toBe(bare);
    // The static policy prefix is byte-identical with and without vocabulary
    // (prompt-cache prefix).
    expect(buildReviewerSystemPrompt(VOCAB).startsWith(bare)).toBe(true);
  });

  it('parses clusters and entity kind/name from the new-topic contract', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => ({
        text: JSON.stringify({
          topics: [
            {
              slug: 'Metric Losses',
              why: 'central',
              isNew: true,
              definition: 'Loss functions defined over arbitrary metric spaces.',
              clusters: ['AI/ML', 'statistics', 'third-one-dropped'],
            },
          ],
          cites: [],
          related: [],
          entities: [{ slug: 'Anthropic', name: 'Anthropic', kind: 'company', why: 'author' }],
        }),
        finishReason: 'stop',
        toolRounds: 0,
      });
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      // Slugs are sanitized at the LLM boundary — they become file paths.
      expect(out.topics[0]!.slug).toBe('metric-losses');
      expect(out.topics[0]!.clusters).toEqual(['ai-ml', 'statistics']);
      expect(out.entities[0]).toEqual({
        slug: 'anthropic',
        why: 'author',
        name: 'Anthropic',
        kind: 'organization',
      });
    } finally {
      cleanup();
    }
  });

  it('drops slugs that sanitize to nothing and unknown entity kinds', async () => {
    const { vault, cleanup } = makeVault();
    try {
      const fakeAgent: ReviewerAgentFn = async () => ({
        text: JSON.stringify({
          topics: [{ slug: '///', why: 'garbage' }, { slug: 'ok-topic', why: 'fine' }],
          cites: [],
          related: [],
          entities: [{ slug: 'openai', why: 'central', kind: 'spaceship' }],
        }),
        finishReason: 'stop',
        toolRounds: 0,
      });
      const out = await runReviewerWith(makeInput(), clients, vault, undefined, fakeAgent);
      expect(out.topics.map((t) => t.slug)).toEqual(['ok-topic']);
      expect(out.entities[0]!.kind).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe('applyReconcileAndGate — fuzzy correction and clusters', () => {
  const existingSlugs = new Set(['agent-memory', 'llm-evaluation', 'quantum-sensing']);
  const sourceExists = (): boolean => false;

  function gate(topics: ReviewerOutput['topics'], slugs = existingSlugs) {
    return applyReconcileAndGate({
      reviewer: { topics, cites: [], related: [], entities: [] },
      existingTopicSlugs: slugs,
      sourceExists,
    });
  }

  it('corrects a near-miss slug onto the known one instead of dropping it', async () => {
    const result = await gate([{ slug: 'quantum-sesning', why: 'typo' }]);
    expect(result.existingTopicSlugs).toEqual(['quantum-sensing']);
    expect(result.gateStats.fuzzyCorrected).toBe(1);
    expect(result.gateStats.droppedHallucinations).toBe(0);
  });

  it('corrects plural drift', async () => {
    const result = await gate([{ slug: 'agent-memories', why: 'plural drift' }]);
    expect(result.existingTopicSlugs).toEqual(['agent-memory']);
    expect(result.gateStats.fuzzyCorrected).toBe(1);
  });

  it('leaves a distant slug alone: a new proposal still creates a new topic', async () => {
    const result = await gate([
      {
        slug: 'photonic-interconnects',
        why: 'genuinely new',
        isNew: true,
        definition: 'Optical links used to move data between chips and racks at low energy per bit.',
        clusters: ['hardware'],
      },
    ]);
    expect(result.gateStats.fuzzyCorrected).toBe(0);
    expect(result.newTopicsToCreate).toEqual([
      {
        slug: 'photonic-interconnects',
        definition: 'Optical links used to move data between chips and racks at low energy per bit.',
        clusters: ['hardware'],
      },
    ]);
  });

  it('never fuzzy-corrects short slugs: gpt-4 is not gpt-4o', async () => {
    // isNearDuplicate's prefix rule has no length floor of its own, so the
    // MIN_FUZZY_SLUG_LEN floor must guard both acceptance branches.
    const result = await gate([{ slug: 'gpt-4', why: 'model page' }], new Set(['gpt-4o']));
    expect(result.gateStats.fuzzyCorrected).toBe(0);
    expect(result.existingTopicSlugs).not.toContain('gpt-4o');
  });

  it('leaves a distant non-new slug as a dropped hallucination', async () => {
    const result = await gate([{ slug: 'photonic-interconnects', why: 'invented' }]);
    expect(result.gateStats.fuzzyCorrected).toBe(0);
    expect(result.gateStats.droppedHallucinations).toBe(1);
    expect(result.existingTopicSlugs).toEqual(['uncategorized']);
  });

  it('a corrected slug loses its new-topic proposal (the existing page owns its definition)', async () => {
    const result = await gate([
      {
        slug: 'quantum-sesning',
        why: 'typo, proposed as new',
        isNew: true,
        definition: 'Measurement techniques exploiting quantum coherence for sensitivity beyond classical limits.',
      },
    ]);
    expect(result.newTopicsToCreate).toEqual([]);
    expect(result.existingTopicSlugs).toEqual(['quantum-sensing']);
    expect(result.gateStats.fuzzyCorrected).toBe(1);
  });

  it('defaults clusters to [] when the reviewer omits them', async () => {
    const result = await gate([
      {
        slug: 'photonic-interconnects',
        why: 'new',
        isNew: true,
        definition: 'Optical links used to move data between chips and racks at low energy per bit.',
      },
    ]);
    expect(result.newTopicsToCreate[0]!.clusters).toEqual([]);
  });

  it('passes entities through unfiltered and de-duplicated (apply creates missing pages)', async () => {
    const result = await applyReconcileAndGate({
      reviewer: {
        topics: [],
        cites: [],
        related: [],
        entities: [
          { slug: 'never-seen-lab', why: 'central', kind: 'organization' },
          { slug: 'never-seen-lab', why: 'dup' },
        ],
      },
      existingTopicSlugs: existingSlugs,
      sourceExists,
    });
    expect(result.entities).toEqual([
      { slug: 'never-seen-lab', name: null, kind: 'organization' },
    ]);
  });
});

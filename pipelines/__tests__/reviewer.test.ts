import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import {
  applyReconcileAndGate,
  runReviewerWith,
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

describe('applyReconcileAndGate', () => {
  const existingSlugs = new Set(['llm-evaluation', 'agent-benchmarks', 'transformers']);
  const sourceFiles = new Set(['arxiv-2403-12345', 'arxiv-2604-25099']);
  const entityFiles = new Set(['anthropic']);
  const sourceExists = (f: string) => sourceFiles.has(f);
  const entityExists = (s: string) => entityFiles.has(s);

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
      entityExists,
    });
    expect(result.existingTopicSlugs).toEqual(['llm-evaluation', 'transformers']);
    expect(result.citeFilenames).toEqual(['arxiv-2403-12345']);
    expect(result.entitySlugs).toEqual(['anthropic']);
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
      entityExists,
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
      entityExists,
    });
    expect(result.newTopicsToCreate).toHaveLength(1);
    expect(result.newTopicsToCreate[0]!.slug).toBe('metric-losses');
    expect(result.existingTopicSlugs).toEqual(['metric-losses']);
  });

  it('rejects a near-duplicate (one-char-off slug)', async () => {
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
      entityExists,
    });
    expect(result.newTopicsToCreate).toEqual([]);
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
      entityExists,
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
      entityExists,
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
      entityExists,
    });
    expect(result.citeFilenames).toEqual(['arxiv-2403-12345']);
  });
});

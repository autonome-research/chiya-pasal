import { describe, it, expect } from 'vitest';
import {
  reconcileTopicOutput,
  isNearDuplicate,
  isSubstantiveDefinition,
  type TopicOutput,
} from '../src/phases/topic-reconciler.js';

describe('reconcileTopicOutput', () => {
  it('folds a false-new slug back into existing', () => {
    const out: TopicOutput = {
      decisions: [{ i: 0, topics: ['platform-interoperability'] }],
      newTopics: [
        { slug: 'platform-interoperability', definition: 'duplicates an existing topic', members: [0] },
      ],
    };
    const r = reconcileTopicOutput(out, new Set(['platform-interoperability', 'foo']));
    expect(r.foldedSlugs).toEqual(['platform-interoperability']);
    expect(r.reconciled.newTopics).toEqual([]);
    expect(r.reconciled.decisions[0]!.topics).toEqual(['platform-interoperability']);
    expect(r.droppedHallucinations).toEqual([]);
  });

  it('keeps a truly-new slug', () => {
    const out: TopicOutput = {
      decisions: [{ i: 0, topics: ['legal-technology'] }],
      newTopics: [{ slug: 'legal-technology', definition: 'new topic', members: [0] }],
    };
    const r = reconcileTopicOutput(out, new Set(['unrelated-slug']));
    expect(r.foldedSlugs).toEqual([]);
    expect(r.reconciled.newTopics).toHaveLength(1);
    expect(r.reconciled.newTopics[0]!.slug).toBe('legal-technology');
    expect(r.reconciled.decisions[0]!.topics).toEqual(['legal-technology']);
  });

  it('dedupes near-duplicate new topics within the same reviewer output', () => {
    const out: TopicOutput = {
      decisions: [{ i: 0, topics: ['rl-in-llms', 'rl-llms'] }],
      newTopics: [
        { slug: 'rl-in-llms', definition: 'Reinforcement learning methods applied inside large language model training and adaptation.', members: [0] },
        { slug: 'rl-llms', definition: 'Reinforcement learning methods for large language models and agent policies.', members: [0] },
      ],
    };
    const r = reconcileTopicOutput(out, new Set());
    expect(r.dedupedNewSlugs).toEqual([{ slug: 'rl-llms', matched: 'rl-in-llms' }]);
    expect(r.reconciled.newTopics.map((t) => t.slug)).toEqual(['rl-in-llms']);
    expect(r.reconciled.decisions[0]!.topics).toEqual(['rl-in-llms']);
  });

  it('drops a hallucinated slug not in existing or proposed', () => {
    const out: TopicOutput = {
      decisions: [{ i: 0, topics: ['real-existing', 'made-up-slug'] }],
      newTopics: [],
    };
    const r = reconcileTopicOutput(out, new Set(['real-existing']));
    expect(r.droppedHallucinations).toEqual([{ i: 0, slug: 'made-up-slug' }]);
    expect(r.reconciled.decisions[0]!.topics).toEqual(['real-existing']);
  });

  it('falls back to "uncategorized" when all of an article\'s slugs are dropped', () => {
    const out: TopicOutput = {
      decisions: [{ i: 0, topics: ['ghost-1', 'ghost-2'] }],
      newTopics: [],
    };
    const r = reconcileTopicOutput(out, new Set(['real']));
    expect(r.droppedHallucinations).toHaveLength(2);
    expect(r.reconciled.decisions[0]!.topics).toEqual(['uncategorized']);
  });

  it('handles a mix of fold + drop + keep across multiple articles', () => {
    const out: TopicOutput = {
      decisions: [
        { i: 0, topics: ['existing-a', 'fake-slug'] },
        { i: 1, topics: ['exists-everywhere', 'truly-new'] },
        { i: 2, topics: ['truly-new'] },
      ],
      newTopics: [
        { slug: 'exists-everywhere', definition: 'should fold', members: [1] },
        { slug: 'truly-new', definition: 'should stay', members: [1, 2] },
      ],
    };
    const r = reconcileTopicOutput(out, new Set(['existing-a', 'exists-everywhere']));
    expect(r.foldedSlugs).toEqual(['exists-everywhere']);
    expect(r.reconciled.newTopics.map((t) => t.slug)).toEqual(['truly-new']);
    expect(r.droppedHallucinations).toEqual([{ i: 0, slug: 'fake-slug' }]);
    expect(r.reconciled.decisions[0]!.topics).toEqual(['existing-a']);
    expect(r.reconciled.decisions[1]!.topics).toEqual(['exists-everywhere', 'truly-new']);
    expect(r.reconciled.decisions[2]!.topics).toEqual(['truly-new']);
  });

  it('idempotent on already-clean input', () => {
    const out: TopicOutput = {
      decisions: [{ i: 0, topics: ['clean'] }],
      newTopics: [{ slug: 'fresh', definition: 'd', members: [0] }],
    };
    const first = reconcileTopicOutput(out, new Set(['clean']));
    const second = reconcileTopicOutput(first.reconciled, new Set(['clean']));
    expect(second.reconciled).toEqual(first.reconciled);
    expect(second.foldedSlugs).toEqual([]);
    expect(second.dedupedNewSlugs).toEqual([]);
    expect(second.droppedHallucinations).toEqual([]);
  });
});

describe('isNearDuplicate', () => {
  it('exact case-insensitive match counts as duplicate', () => {
    const r = isNearDuplicate('LLM-Evaluation', new Set(['llm-evaluation']));
    expect(r.duplicate).toBe(true);
    if (r.duplicate) expect(r.matched).toBe('llm-evaluation');
  });

  it('normalized (dashes stripped) match counts as duplicate', () => {
    const r = isNearDuplicate('llm-eval-uation', new Set(['llmevaluation']));
    expect(r.duplicate).toBe(true);
  });

  it('strict prefix with diff <=3 chars counts as duplicate', () => {
    const r = isNearDuplicate('llm-evaluations', new Set(['llm-evaluation']));
    expect(r.duplicate).toBe(true);
  });

  it('clearly different slug is not a duplicate', () => {
    const r = isNearDuplicate('agent-commerce', new Set(['llm-evaluation', 'transformers']));
    expect(r.duplicate).toBe(false);
  });
});

describe('isSubstantiveDefinition', () => {
  it('rejects too-short definitions', () => {
    expect(isSubstantiveDefinition('AI stuff.')).toBe(false);
  });

  it('rejects too-few-words definitions', () => {
    expect(isSubstantiveDefinition('Papers about machine learning.')).toBe(false);
  });

  it('accepts a substantive 1-sentence definition', () => {
    expect(isSubstantiveDefinition(
      'Loss functions defined over arbitrary metric spaces, used in classification beyond 0-1.',
    )).toBe(true);
  });

  it('accepts a multi-sentence definition', () => {
    expect(isSubstantiveDefinition(
      'A research area focused on the application of machine learning to clinical outcomes. Includes survival analysis, time-series prediction, and pathway monitoring.',
    )).toBe(true);
  });
});

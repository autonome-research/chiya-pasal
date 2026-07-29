import { describe, it, expect } from 'vitest';

import {
  draftOneSectionWith,
  renderSectionFallback,
  type SectionAgentFn,
} from '../src/phases/digest/draft.js';
import type { ClassifiedArticle } from '../src/shared/digest-types.js';

function makeClassified(overrides: Partial<ClassifiedArticle> = {}): ClassifiedArticle {
  return {
    article: {
      title: 'Sparse Autoencoders Find Highly Interpretable Features',
      url: 'https://arxiv.org/abs/2309.08600',
      source: 'arXiv',
      field: 'AI/ML',
      snippet: 'We use sparse autoencoders to decompose activations...',
    },
    bucket: 'notable',
    reason: 'SAE feature decomposition directly relevant to interp focus',
    wikilinks: [],
    ...overrides,
  };
}

describe('draftOneSectionWith — retry/fallback policy', () => {
  it('returns the static empty-section body without calling the agent', async () => {
    let calls = 0;
    const agentFn: SectionAgentFn = async () => {
      calls += 1;
      return { text: 'x', finishReason: 'stop' };
    };
    const out = await draftOneSectionWith('📚 New & Notable', [], agentFn);
    expect(out.body).toBe('_Nothing this cycle._');
    expect(out.warning).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('uses the first attempt when it completes', async () => {
    const budgets: number[] = [];
    const agentFn: SectionAgentFn = async (maxTokens) => {
      budgets.push(maxTokens);
      return { text: '- [T](u) — why [AI/ML]\n', finishReason: 'stop' };
    };
    const out = await draftOneSectionWith('📚 New & Notable', [makeClassified()], agentFn);
    expect(out.body).toBe('- [T](u) — why [AI/ML]');
    expect(out.warning).toBeUndefined();
    expect(budgets).toHaveLength(1);
  });

  it('retries once with a doubled budget after truncation', async () => {
    const budgets: number[] = [];
    const agentFn: SectionAgentFn = async (maxTokens) => {
      budgets.push(maxTokens);
      return budgets.length === 1
        ? { text: 'partial…', finishReason: 'length' }
        : { text: '- [T](u) — why [AI/ML]', finishReason: 'stop' };
    };
    const out = await draftOneSectionWith('📚 New & Notable', [makeClassified()], agentFn);
    expect(out.body).toBe('- [T](u) — why [AI/ML]');
    expect(out.warning).toBeUndefined();
    expect(budgets).toHaveLength(2);
    expect(budgets[1]).toBe(budgets[0] * 2);
  });

  it('treats an empty completion as a failed attempt', async () => {
    let calls = 0;
    const agentFn: SectionAgentFn = async () => {
      calls += 1;
      return calls === 1
        ? { text: '   ', finishReason: 'stop' }
        : { text: '- [T](u) — why [AI/ML]', finishReason: 'stop' };
    };
    const out = await draftOneSectionWith('📚 New & Notable', [makeClassified()], agentFn);
    expect(out.body).toBe('- [T](u) — why [AI/ML]');
    expect(calls).toBe(2);
  });

  it('falls back to the deterministic rendering when both attempts truncate', async () => {
    const agentFn: SectionAgentFn = async () => ({ text: 'partial…', finishReason: 'length' });
    const classified = [
      makeClassified(),
      makeClassified({
        article: {
          title: 'Second Paper',
          url: 'https://example.org/p2',
          source: null,
          field: 'Robotics',
          snippet: null,
        },
        bucket: 'followup',
        reason: 'extends existing SLAM coverage',
        wikilinks: ['wiki/topics/slam'],
      }),
    ];
    const out = await draftOneSectionWith('📚 New & Notable', classified, agentFn);
    expect(out.body).toBe(renderSectionFallback(classified));
    expect(out.warning).toContain('deterministic fallback');
    expect(out.warning).toContain('📚 New & Notable');
  });
});

describe('renderSectionFallback', () => {
  it('renders the section bullet contract from classifier output alone', () => {
    const body = renderSectionFallback([
      makeClassified({ wikilinks: ['wiki/topics/slam'] }),
    ]);
    expect(body).toBe(
      '- [Sparse Autoencoders Find Highly Interpretable Features](https://arxiv.org/abs/2309.08600)' +
        ' — SAE feature decomposition directly relevant to interp focus' +
        ' (extends wiki/topics/slam) [AI/ML]',
    );
  });
});

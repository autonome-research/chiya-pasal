import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';

import { callSummary, type SummaryInput } from '../src/phases/summary.js';
import type { ArticleRow } from '../src/shared/article-store.js';

const makeArticle = (overrides: Partial<ArticleRow> = {}): ArticleRow => ({
  id: 1,
  url: 'https://arxiv.org/abs/2605.03823',
  urlHash: 'abc',
  title: 'A Study of Things',
  titleHash: 'def',
  source: 'arXiv',
  field: 'AI/ML',
  snippet: 'A short snippet here.',
  collectedAt: new Date('2026-05-01T12:00:00Z'),
  collectedFrom: 'matcha',
  status: 'processing',
  statusReason: null,
  processedAt: null,
  pagePaths: [],
  ...overrides,
});

const makeInput = (overrides: Partial<SummaryInput> = {}): SummaryInput => ({
  article: makeArticle(),
  body: 'A short snippet here, plus more body text.',
  ...overrides,
});

describe('callSummary — truncation', () => {
  it('throws an error mentioning truncation when the LLM returns finishReason: length', async () => {
    const finalDelta = 'partial summary text without...';
    const sseStream = makeFakeStream([
      { choices: [{ delta: { content: finalDelta }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'length', index: 0 }] },
    ]);
    const client = {
      chat: {
        completions: {
          create: async () => sseStream,
        },
      },
    } as unknown as OpenAI;

    await expect(
      callSummary(makeInput(), { client, model: 'fake-model' }),
    ).rejects.toThrow(/truncated/i);
  });
});

function makeFakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) {
            return { value: chunks[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

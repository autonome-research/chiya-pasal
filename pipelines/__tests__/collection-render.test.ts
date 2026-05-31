import { describe, expect, it } from 'vitest';

import { renderJsonl, toApiArticleJson } from '../src/collection/render.js';
import type { ArticleCandidate } from '../src/collection/source-adapter.js';

describe('collection render compatibility', () => {
  const candidate: ArticleCandidate = {
    title: 'A Paper',
    url: 'https://example.com/paper',
    source: 'OpenAlex',
    field: 'AI/ML',
    abstract: 'Long abstract text',
    publishedAt: new Date('2026-05-01T00:00:00Z'),
    metadata: { citations: 42 },
  };

  it('maps ArticleCandidate to filter_matcha-compatible JSON fields', () => {
    expect(toApiArticleJson(candidate)).toEqual({
      title: 'A Paper',
      abstract: 'Long abstract text',
      url: 'https://example.com/paper',
      source: 'OpenAlex',
      domain: 'AI/ML',
      citations: 42,
      year: '2026',
      abstract_short: 'Long abstract text',
    });
  });

  it('renders JSONL', () => {
    const jsonl = renderJsonl([candidate]);
    expect(jsonl.trim()).toBe(JSON.stringify(toApiArticleJson(candidate)));
  });
});

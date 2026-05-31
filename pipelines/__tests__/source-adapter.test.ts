import { describe, expect, it } from 'vitest';

import {
  isArticleCandidate,
  makeReport,
  normalizeCandidate,
  type SourceAdapter,
} from '../src/collection/source-adapter.js';
import { SourceRegistry } from '../src/collection/registry.js';

describe('source adapter scaffold', () => {
  it('validates and normalizes article candidates', () => {
    const candidate = normalizeCandidate({
      title: '  A   Paper  ',
      url: ' https://example.com/paper ',
      source: ' Test Source ',
      field: ' AI ',
      abstract: '  abstract  ',
      doi: ' 10.1234/ABC ',
      authors: [' Alice ', '', ' Bob '],
    });

    expect(isArticleCandidate(candidate)).toBe(true);
    expect(candidate).toMatchObject({
      title: 'A Paper',
      url: 'https://example.com/paper',
      source: 'Test Source',
      field: 'AI',
      abstract: 'abstract',
      doi: '10.1234/abc',
      authors: ['Alice', 'Bob'],
    });
  });

  it('registers and runs adapters by name', async () => {
    const adapter: SourceAdapter<{ q: string }> = {
      name: 'demo',
      async fetch(config) {
        return {
          candidates: [normalizeCandidate({ title: config.q, url: 'https://example.com', source: 'demo' })],
          report: makeReport('demo', { fetched: 1, emitted: 1 }),
        };
      },
    };

    const registry = new SourceRegistry().register(adapter);
    expect(registry.list()).toEqual(['demo']);

    const results = await registry.runAll({ demo: { q: 'hello' } }, { now: new Date(0), interests: {} });
    expect(results[0]!.candidates[0]!.title).toBe('hello');
    expect(results[0]!.report).toMatchObject({ source: 'demo', fetched: 1, emitted: 1 });
  });
});

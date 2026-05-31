import { describe, it, expect } from 'vitest';

import { formatSourcePage, type SourcePageInput } from '../src/phases/page-templates.js';

function base(over: Partial<SourcePageInput> = {}): SourcePageInput {
  return {
    stableId: { kind: 'url', hash: 'abc123def456' },
    url: 'http://example.com/x',
    sourceName: 'arXiv',
    collected: new Date('2026-05-31T00:00:00Z'),
    title: 'A Test Paper',
    field: 'AI/ML',
    topics: ['reinforcement-learning'],
    cites: [],
    summary: 'A summary.',
    ...over,
  };
}

describe('formatSourcePage — Related sources', () => {
  it('renders related siblings as source wikilinks (graph edges)', () => {
    const page = formatSourcePage(base({ related: ['arxiv-2605-00001', 'doi-10-1-x'] }));
    expect(page).toContain('## Related sources');
    expect(page).toContain('- [[wiki/sources/arxiv-2605-00001]]');
    expect(page).toContain('- [[wiki/sources/doi-10-1-x]]');
    expect(page).toContain('related: [arxiv-2605-00001, doi-10-1-x]');
  });

  it('shows a placeholder when there are no related sources', () => {
    const page = formatSourcePage(base());
    expect(page).toContain('## Related sources');
    expect(page).toContain('_None._');
    expect(page).toContain('related: []');
  });

  it('still renders the other sections', () => {
    const page = formatSourcePage(base({ related: ['arxiv-2605-00001'] }));
    for (const s of ['## Summary', '## Topics', '## Cited references in this library', '## Cited by']) {
      expect(page).toContain(s);
    }
  });
});

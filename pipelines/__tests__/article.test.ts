import { describe, it, expect } from 'vitest';
import { parseArticles } from '../src/shared/article.js';

const SAMPLE = `---
source: matcha-pipeline
clipped: 2026-04-25T08:10:02
---

# Raw Articles — 2026-04-25

> blurb

---
### Collected at 08:10
### 3 new articles

#### AI/ML
- [Title One](https://example.com/1) *(Crossref)* — first snippet
- [Title Two](10.1234/doi-only) *(NCBI)*

#### Biology
- [Title Three](https://example.com/3)
`;

describe('parseArticles', () => {
  it('parses fields, titles, urls, sources, snippets', () => {
    const arts = parseArticles(SAMPLE);
    expect(arts).toHaveLength(3);
    expect(arts[0]).toEqual({
      title: 'Title One',
      url: 'https://example.com/1',
      source: 'Crossref',
      field: 'AI/ML',
      snippet: 'first snippet',
    });
    expect(arts[1]).toEqual({
      title: 'Title Two',
      url: '10.1234/doi-only',
      source: 'NCBI',
      field: 'AI/ML',
      snippet: null,
    });
    expect(arts[2]).toEqual({
      title: 'Title Three',
      url: 'https://example.com/3',
      source: null,
      field: 'Biology',
      snippet: null,
    });
  });

  it('skips frontmatter', () => {
    expect(parseArticles(SAMPLE).every((a) => !a.title.includes('source'))).toBe(true);
  });

  it('handles a file with no articles', () => {
    expect(parseArticles('# empty\n\n---\n')).toEqual([]);
  });
});

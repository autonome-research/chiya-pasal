import { describe, expect, it } from 'vitest';

import { arxivSource, buildArxivApiUrl, parseArxivAtom } from '../src/collection/sources/arxiv.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2605.03823v2</id>
    <updated>2026-05-08T00:00:00Z</updated>
    <published>2026-05-06T00:00:00Z</published>
    <title> Realizable   Bayes-Consistency for General Metric Losses </title>
    <summary> We study &amp; prove results over metric losses. </summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
    <arxiv:doi>10.1234/ABC</arxiv:doi>
  </entry>
</feed>`;

describe('arxiv source adapter', () => {
  it('builds an arXiv API URL from config', () => {
    const url = buildArxivApiUrl({ query: 'cat:cs.AI', maxResults: 7 });
    expect(url).toContain('https://export.arxiv.org/api/query?');
    expect(url).toContain('search_query=cat%3Acs.AI');
    expect(url).toContain('max_results=7');
    expect(url).toContain('sortBy=submittedDate');
  });

  it('parses Atom entries into ArticleCandidate records', () => {
    const candidates = parseArxivAtom(SAMPLE, 'AI/ML');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      title: 'Realizable Bayes-Consistency for General Metric Losses',
      url: 'http://arxiv.org/abs/2605.03823v2',
      source: 'arXiv',
      field: 'AI/ML',
      abstract: 'We study & prove results over metric losses.',
      authors: ['Alice Example', 'Bob Example'],
      doi: '10.1234/abc',
      arxivId: '2605.03823',
    });
    expect(candidates[0]!.publishedAt?.toISOString()).toBe('2026-05-06T00:00:00.000Z');
  });

  it('fetches using injected fetch and returns a report', async () => {
    const fetch = async (url: string | URL | Request) => {
      expect(String(url)).toContain('search_query=cat%3Acs.LG');
      return new Response(SAMPLE, { status: 200 });
    };

    const result = await arxivSource.fetch(
      { query: 'cat:cs.LG', maxResults: 1, field: 'Machine Learning' },
      { now: new Date(0), interests: {}, fetch },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.field).toBe('Machine Learning');
    expect(result.report).toMatchObject({ source: 'arxiv', fetched: 1, emitted: 1, dropped: 0 });
  });
});

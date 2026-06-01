import { describe, expect, it } from 'vitest';

import { parseCrossref } from '../src/collection/sources/crossref.js';
import { parseOpenAlex } from '../src/collection/sources/openalex.js';
import { parseSemanticScholar } from '../src/collection/sources/semantic-scholar.js';

describe('academic source parsers', () => {
  it('parses OpenAlex works including inverted-index abstracts', () => {
    const candidates = parseOpenAlex({
      results: [{
        title: 'OpenAlex Paper',
        doi: 'https://doi.org/10.123/OA',
        publication_date: '2026-05-01',
        cited_by_count: 12,
        abstract_inverted_index: { This: [0], works: [1] },
        topics: [{ display_name: 'AI' }],
        authorships: [{ author: { display_name: 'Alice' } }],
      }],
    });

    expect(candidates[0]).toMatchObject({
      title: 'OpenAlex Paper',
      url: 'https://doi.org/10.123/OA',
      source: 'OpenAlex',
      field: 'AI',
      abstract: 'This works',
      doi: '10.123/oa',
      authors: ['Alice'],
      metadata: { citations: 12 },
    });
  });

  it('parses Crossref works and strips abstract tags', () => {
    const candidates = parseCrossref({
      message: {
        items: [{
          title: ['Crossref Paper'],
          DOI: '10.555/CROSS',
          abstract: '<jats:p>Tagged abstract.</jats:p>',
          subject: ['Materials'],
          author: [{ given: 'Ada', family: 'Lovelace' }],
          issued: { 'date-parts': [[2025, 2, 3]] },
          'is-referenced-by-count': 7,
        }],
      },
    });

    expect(candidates[0]).toMatchObject({
      title: 'Crossref Paper',
      url: 'https://doi.org/10.555/CROSS',
      source: 'Crossref',
      field: 'Materials',
      abstract: 'Tagged abstract.',
      doi: '10.555/cross',
      authors: ['Ada Lovelace'],
      metadata: { citations: 7 },
    });
  });

  it('parses Semantic Scholar papers with DOI fallback URLs', () => {
    const candidates = parseSemanticScholar({
      data: [{
        title: 'Semantic Scholar Paper',
        abstract: 'Abstract',
        year: 2024,
        fieldsOfStudy: ['Computer Science'],
        citationCount: 99,
        authors: [{ name: 'Grace Hopper' }],
        externalIds: { DOI: '10.999/SS', ArXiv: '2605.00001' },
      }],
    });

    expect(candidates[0]).toMatchObject({
      title: 'Semantic Scholar Paper',
      url: 'https://doi.org/10.999/SS',
      source: 'Semantic Scholar',
      field: 'Computer Science',
      abstract: 'Abstract',
      doi: '10.999/ss',
      arxivId: '2605.00001',
      authors: ['Grace Hopper'],
      metadata: { citations: 99 },
    });
  });
});

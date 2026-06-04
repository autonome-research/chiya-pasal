import { describe, expect, it } from 'vitest';

import {
  isArticleCandidate,
  makeReport,
  normalizeCandidate,
  type SourceAdapter,
} from '../src/collection/source-adapter.js';
import { SourceRegistry } from '../src/collection/registry.js';
import {
  doajSource,
  europePmcSource,
  inspireHepSource,
  ncbiSource,
  osfSource,
  parseEuropePmc,
  parseInspireHep,
  parseOsf,
  parseZenodo,
  zenodoSource,
} from '../src/collection/sources/legacy-academic.js';

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

  it('registers the legacy API parity adapters', () => {
    const registry = new SourceRegistry()
      .register(zenodoSource)
      .register(doajSource)
      .register(europePmcSource)
      .register(inspireHepSource)
      .register(ncbiSource)
      .register(osfSource);

    expect(registry.list()).toEqual(['doaj', 'europe-pmc', 'inspire-hep', 'ncbi', 'osf', 'zenodo']);
  });

  it('parses representative legacy API responses', () => {
    expect(parseZenodo({ hits: { hits: [{ id: 1, metadata: { title: 'Z', doi: '10.1/z', description: 'abs' } }] } })[0]).toMatchObject({
      title: 'Z', source: 'Zenodo', doi: '10.1/z', url: 'https://doi.org/10.1/z',
    });
    expect(parseEuropePmc({ resultList: { result: [{ title: 'E', pmcid: 'PMC1', abstractText: 'abs' }] } })[0]).toMatchObject({
      title: 'E', source: 'Europe PMC', url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
    });
    expect(parseInspireHep({ hits: { hits: [{ id: 2, metadata: { titles: [{ title: 'I' }], citation_count: 3 } }] } })[0]).toMatchObject({
      title: 'I', source: 'INSPIRE-HEP', url: 'https://inspirehep.net/literature/2',
    });
    expect(parseOsf({ data: [{ attributes: { title: 'O' }, links: { self: 'https://api.osf.io/v2/preprints/hnjbx_v1/' } }] })[0]).toMatchObject({
      title: 'O', source: 'OSF', url: 'https://osf.io/hnjbx',
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

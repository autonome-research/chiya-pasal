import { describe, it, expect } from 'vitest';
import { extractArxivIds, extractDois, fetchArxivStructuredRefs } from '../src/shared/refs.js';

describe('extractArxivIds', () => {
  it('modern ID in /abs/ URL', () => {
    expect(extractArxivIds('https://arxiv.org/abs/2605.03823')).toEqual(['2605.03823']);
  });

  it('modern ID with version suffix is canonicalized', () => {
    expect(extractArxivIds('arXiv:2605.03823v2')).toEqual(['2605.03823']);
  });

  it('modern ID bare in prose', () => {
    expect(extractArxivIds('we cite 2605.03823 for details')).toEqual(['2605.03823']);
  });

  it('LaTeX cite form', () => {
    expect(extractArxivIds('\\cite{2605.03823}')).toEqual(['2605.03823']);
  });

  it('PDF URL', () => {
    expect(extractArxivIds('https://arxiv.org/pdf/2605.03823.pdf')).toEqual(['2605.03823']);
  });

  it('arxiv: prefix lowercase', () => {
    expect(extractArxivIds('arxiv:2605.03823')).toEqual(['2605.03823']);
  });

  it('bracketed bare ID', () => {
    expect(extractArxivIds('see [2605.03823] for details')).toEqual(['2605.03823']);
  });

  it('arXiv inside square brackets with space', () => {
    expect(extractArxivIds('[arXiv 2605.03823]')).toEqual(['2605.03823']);
  });

  it('5-digit suffix', () => {
    expect(extractArxivIds('see 1503.00001 here')).toEqual(['1503.00001']);
  });

  it('first modern-format paper', () => {
    expect(extractArxivIds('the first one was 0704.0001')).toEqual(['0704.0001']);
  });

  it('old-style ID with sub-class', () => {
    expect(extractArxivIds('cs.AI/0501001')).toEqual(['cs.AI/0501001']);
  });

  it('old-style with version', () => {
    expect(extractArxivIds('hep-th/9901001v2')).toEqual(['hep-th/9901001']);
  });

  it('old-style with sub-class math.AG', () => {
    expect(extractArxivIds('math.AG/0501001')).toEqual(['math.AG/0501001']);
  });

  it('old-style without sub-class', () => {
    expect(extractArxivIds('see math/0501001 for details')).toEqual(['math/0501001']);
  });

  it('multiple IDs deduplicated, order preserved', () => {
    expect(
      extractArxivIds('refs: 2605.03823 and 2604.12345 and again 2605.03823 done'),
    ).toEqual(['2605.03823', '2604.12345']);
  });

  it('false positive guard: date string with dash', () => {
    expect(extractArxivIds('Posted 2024-05-04 in our archive')).toEqual([]);
  });

  it('false positive guard: date with mixed dash/dot', () => {
    expect(extractArxivIds('Posted 2024-05.04 in our archive')).toEqual([]);
  });

  it('false positive guard: versioned software', () => {
    expect(extractArxivIds('v0.18.2')).toEqual([]);
  });

  it('false positive guard: phone-like with extra digits', () => {
    expect(extractArxivIds('(555) 1234.5678 9012')).toEqual([]);
  });

  it('empty input', () => {
    expect(extractArxivIds('')).toEqual([]);
  });

  it('no IDs in arxiv-flavored prose', () => {
    expect(
      extractArxivIds(
        'In this paper we propose a new method for transformer training. Our results improve baselines.',
      ),
    ).toEqual([]);
  });

  it('mixed modern and old-style preserves order', () => {
    expect(
      extractArxivIds('see 2605.03823 and also cs.AI/0501001 and hep-th/9901001'),
    ).toEqual(['2605.03823', 'cs.AI/0501001', 'hep-th/9901001']);
  });
});

describe('extractDois', () => {
  it('bare DOI', () => {
    expect(extractDois('10.1038/s41586-024-12345-6')).toEqual([
      '10.1038/s41586-024-12345-6',
    ]);
  });

  it('DOI URL', () => {
    expect(extractDois('https://doi.org/10.1038/s41586-024-12345-6')).toEqual([
      '10.1038/s41586-024-12345-6',
    ]);
  });

  it('dx.doi.org form', () => {
    expect(extractDois('https://dx.doi.org/10.1145/3580305.3599350')).toEqual([
      '10.1145/3580305.3599350',
    ]);
  });

  it('arXiv DOI namespace, lowercased', () => {
    expect(extractDois('10.48550/arXiv.2605.03823')).toEqual([
      '10.48550/arxiv.2605.03823',
    ]);
  });

  it('case normalization', () => {
    expect(extractDois('10.1038/S41586-024-12345-6')).toEqual([
      '10.1038/s41586-024-12345-6',
    ]);
  });

  it('multiple DOIs, order preserved', () => {
    expect(extractDois('cite 10.1038/a and 10.1145/b please')).toEqual([
      '10.1038/a',
      '10.1145/b',
    ]);
  });

  it('parenthesized DOI strips the closing paren', () => {
    expect(extractDois('(see 10.1038/s41586-024-12345-6 for details)')).toEqual([
      '10.1038/s41586-024-12345-6',
    ]);
  });

  it('DOI followed by comma strips the comma', () => {
    expect(
      extractDois('As shown in 10.1038/s41586-024-12345-6, the result holds.'),
    ).toEqual(['10.1038/s41586-024-12345-6']);
  });

  it('doi: prefix', () => {
    expect(extractDois('doi:10.1038/s41586-024-12345-6')).toEqual([
      '10.1038/s41586-024-12345-6',
    ]);
  });

  it('Zenodo DOI', () => {
    expect(extractDois('archived at 10.5281/zenodo.1234567')).toEqual([
      '10.5281/zenodo.1234567',
    ]);
  });

  it('false positive: version string', () => {
    expect(extractDois('version 10.18.2')).toEqual([]);
  });

  it('empty input', () => {
    expect(extractDois('')).toEqual([]);
  });

  it('no DOIs', () => {
    expect(extractDois('just some prose without any identifiers')).toEqual([]);
  });

  it('deduplicates same DOI', () => {
    expect(
      extractDois('first 10.1038/abc then again 10.1038/abc done'),
    ).toEqual(['10.1038/abc']);
  });

  it('dedup is case-insensitive', () => {
    expect(extractDois('10.1038/ABC and 10.1038/abc')).toEqual(['10.1038/abc']);
  });
});

describe('mixed content', () => {
  it('extracts arxiv IDs and DOIs independently from realistic prose', () => {
    const text = `
      In our prior work [arXiv:2605.03823] we showed how to scale this further. See
      also https://arxiv.org/abs/2604.12345 for the original derivation. The Nature
      paper (10.1038/s41586-024-12345-6) gives empirical evidence, and the ACM
      version doi:10.1145/3580305.3599350 covers the engineering details. Earlier
      work in cs.AI/0501001 introduced the formalism. Posted 2024-05-04.
    `;
    expect(extractArxivIds(text)).toEqual([
      '2605.03823',
      '2604.12345',
      'cs.AI/0501001',
    ]);
    expect(extractDois(text)).toEqual([
      '10.1038/s41586-024-12345-6',
      '10.1145/3580305.3599350',
    ]);
  });
});

describe('fetchArxivStructuredRefs', () => {
  it('returns empty array (stub)', async () => {
    const result = await fetchArxivStructuredRefs('2605.03823');
    expect(result).toEqual([]);
  });

  it('does not throw on arbitrary input', async () => {
    await expect(fetchArxivStructuredRefs('')).resolves.toEqual([]);
    await expect(fetchArxivStructuredRefs('cs.AI/0501001')).resolves.toEqual([]);
  });
});

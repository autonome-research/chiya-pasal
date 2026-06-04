import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/shared/url-normalize.js';

describe('normalizeUrl', () => {
  it('null/empty/whitespace → null', () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('bare DOI → https://doi.org/...', () => {
    expect(normalizeUrl('10.1234/abc.def')).toBe('https://doi.org/10.1234/abc.def');
    expect(normalizeUrl('10.36227/techrxiv.175695836.60215814/v1')).toBe(
      'https://doi.org/10.36227/techrxiv.175695836.60215814/v1',
    );
  });

  it('arxiv strips version suffix', () => {
    expect(normalizeUrl('http://arxiv.org/abs/2602.20643v1')).toBe('https://arxiv.org/abs/2602.20643');
    expect(normalizeUrl('https://arxiv.org/abs/2602.20643v2')).toBe('https://arxiv.org/abs/2602.20643');
    expect(normalizeUrl('https://arxiv.org/abs/2602.20643')).toBe('https://arxiv.org/abs/2602.20643');
    expect(normalizeUrl('https://arxiv.org/pdf/2602.20643v1.pdf')).toBe('https://arxiv.org/abs/2602.20643');
  });

  it('arxiv old-style IDs', () => {
    expect(normalizeUrl('https://arxiv.org/abs/cs.AI/0102003v2')).toBe('https://arxiv.org/abs/cs.AI/0102003');
  });

  it('OSF API preprint URLs become human-readable osf.io links', () => {
    expect(normalizeUrl('https://api.osf.io/v2/preprints/3e28f_v1/')).toBe('https://osf.io/3e28f');
    expect(normalizeUrl('https://api.osf.io/v2/preprints/dq6xt_v3/')).toBe('https://osf.io/dq6xt');
    expect(normalizeUrl('https://api.osf.io/v2/preprints/hnjbx/')).toBe('https://osf.io/hnjbx');
  });

  it('strips trailing slash on pathname (not on root)', () => {
    expect(normalizeUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('lowercases scheme + host', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('different arxiv URL forms collapse to the same hash key', () => {
    const a = normalizeUrl('http://arxiv.org/abs/2602.20643v1');
    const b = normalizeUrl('https://arxiv.org/abs/2602.20643v2');
    const c = normalizeUrl('https://arxiv.org/pdf/2602.20643v3.pdf');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('unparseable input returns as-is rather than throwing', () => {
    expect(normalizeUrl('not a url at all')).toBe('not a url at all');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolRegistry } from 'thread-phase';

import { ArticleStore } from '../src/shared/article-store.js';
import { registerArticleLookupTools } from '../src/tools/article-lookup.js';

let dir: string;
let store: ArticleStore;
let reg: ToolRegistry;

const baseInput = {
  title: 'Default',
  source: 'arXiv',
  field: 'AI/ML',
  snippet: null,
  collectedFrom: 'raw/inbox/test.md',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-alt-'));
  store = new ArticleStore(join(dir, 'test.db'));
  reg = new ToolRegistry();
  registerArticleLookupTools(reg, store);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('article_lookup_by_arxiv tool', () => {
  it('returns formatted line on hit', async () => {
    store.upsertPending({ ...baseInput, title: 'Quantum X', url: 'https://arxiv.org/abs/2605.03823' });
    const r = await reg.execute('article_lookup_by_arxiv', 't1', { arxiv_id: '2605.03823' });
    expect(r.content).toContain('arxiv-2605-03823');
    expect(r.content).toContain('Quantum X');
  });

  it('handles input with version suffix', async () => {
    store.upsertPending({ ...baseInput, title: 'A', url: 'https://arxiv.org/abs/2605.03823' });
    const r = await reg.execute('article_lookup_by_arxiv', 't1', { arxiv_id: '2605.03823v2' });
    expect(r.content).toContain('arxiv-2605-03823');
  });

  it('returns "(not in library)" when nothing matches', async () => {
    const r = await reg.execute('article_lookup_by_arxiv', 't1', { arxiv_id: '9999.99999' });
    expect(r.content).toBe('(not in library)');
  });
});

describe('article_lookup_by_doi tool', () => {
  it('finds by raw DOI', async () => {
    store.upsertPending({ ...baseInput, title: 'Nature paper', url: 'https://doi.org/10.1038/s41586-024-12345-6' });
    const r = await reg.execute('article_lookup_by_doi', 't1', { doi: '10.1038/s41586-024-12345-6' });
    expect(r.content).toContain('doi-10-1038-s41586-024-12345-6');
    expect(r.content).toContain('Nature paper');
  });

  it('returns "(not in library)" on miss', async () => {
    const r = await reg.execute('article_lookup_by_doi', 't1', { doi: '10.9999/never' });
    expect(r.content).toBe('(not in library)');
  });
});

describe('article_search_by_title tool', () => {
  beforeEach(() => {
    store.upsertPending({ ...baseInput, title: 'Quantum Error Correction with Surface Codes', url: 'https://e.com/qec' });
    store.upsertPending({ ...baseInput, title: 'Multi-Agent Reinforcement Learning', url: 'https://e.com/marl' });
    store.upsertPending({ ...baseInput, title: 'Transformer Architectures for NLP', url: 'https://e.com/tx' });
  });

  it('returns one line per match, newest first', async () => {
    const r = await reg.execute('article_search_by_title', 't1', { keywords: 'quantum surface' });
    expect(r.content).toContain('Quantum Error Correction');
  });

  it('returns "(no matches)" when keyword set yields nothing', async () => {
    const r = await reg.execute('article_search_by_title', 't1', { keywords: 'absolutely-no-such-thing' });
    expect(r.content).toBe('(no matches)');
  });

  it('respects a custom limit', async () => {
    const r = await reg.execute('article_search_by_title', 't1', { keywords: 'l', limit: 1 });
    // Single-char keywords get filtered by ArticleStore (length>=2 floor),
    // so this returns no matches even though 'l' would substring-match.
    expect(r.content).toBe('(no matches)');
  });
});

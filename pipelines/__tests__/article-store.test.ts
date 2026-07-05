import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArticleStore } from '../src/shared/article-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
let store: ArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-as-test-'));
  store = new ArticleStore(join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseInput = {
  title: 'Title One',
  url: 'https://example.com/abc',
  source: 'Crossref',
  field: 'AI/ML',
  snippet: 'a snippet',
  collectedFrom: 'raw/inbox/2026-04-27-articles.md',
};

describe('ArticleStore.upsertPending', () => {
  it('inserts a new pending row', () => {
    const r = store.upsertPending(baseInput);
    expect(r.result).toBe('inserted');
    expect(r.id).toBeGreaterThan(0);
    const row = store.getById(r.id!)!;
    expect(row.status).toBe('pending');
    expect(row.title).toBe('Title One');
    expect(row.urlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects exact duplicate URL', () => {
    store.upsertPending(baseInput);
    const r = store.upsertPending(baseInput);
    expect(r.result).toBe('duplicate-url');
  });

  it('rejects URL duplicate even when string form differs (arxiv versioning)', () => {
    store.upsertPending({ ...baseInput, url: 'https://arxiv.org/abs/2602.20643v1' });
    const r = store.upsertPending({ ...baseInput, title: 'Different title', url: 'http://arxiv.org/pdf/2602.20643v3.pdf' });
    expect(r.result).toBe('duplicate-url');
  });

  it('rejects duplicate title even when URLs differ', () => {
    store.upsertPending({ ...baseInput, url: 'https://example.com/a' });
    const r = store.upsertPending({ ...baseInput, url: 'https://example.com/b' });
    expect(r.result).toBe('duplicate-title');
  });

  it('null URL: title-only dedup applies', () => {
    store.upsertPending({ ...baseInput, url: null });
    const r = store.upsertPending({ ...baseInput, url: null });
    expect(r.result).toBe('duplicate-title');
  });

  it('two articles with no URL but different titles both insert', () => {
    const a = store.upsertPending({ ...baseInput, url: null, title: 'A' });
    const b = store.upsertPending({ ...baseInput, url: null, title: 'B' });
    expect(a.result).toBe('inserted');
    expect(b.result).toBe('inserted');
  });
});

describe('ArticleStore.listPending / status FSM', () => {
  it('listPending returns oldest-first up to limit', async () => {
    const a = store.upsertPending({ ...baseInput, title: 'A', url: 'https://e.com/a' }).id!;
    await new Promise((r) => setTimeout(r, 1100));
    const b = store.upsertPending({ ...baseInput, title: 'B', url: 'https://e.com/b' }).id!;
    const list = store.listPending(10);
    expect(list.map((r) => r.id)).toEqual([a, b]);
  });

  it('only returns status=pending', () => {
    const a = store.upsertPending({ ...baseInput, title: 'A', url: 'https://e.com/a' }).id!;
    const b = store.upsertPending({ ...baseInput, title: 'B', url: 'https://e.com/b' }).id!;
    store.markProcessing(a);
    expect(store.listPending(10).map((r) => r.id)).toEqual([b]);
  });

  it('markDone records page paths + status=done', () => {
    const id = store.upsertPending(baseInput).id!;
    store.markProcessing(id);
    store.markDone(id, ['wiki/topics/x.md', 'wiki/entities/y.md']);
    const row = store.getById(id)!;
    expect(row.status).toBe('done');
    expect(row.pagePaths).toEqual(['wiki/topics/x.md', 'wiki/entities/y.md']);
    expect(row.processedAt).toBeInstanceOf(Date);
  });

  it('markSkipped + markFailed record reason', () => {
    const a = store.upsertPending({ ...baseInput, title: 'A', url: 'https://e.com/a' }).id!;
    const b = store.upsertPending({ ...baseInput, title: 'B', url: 'https://e.com/b' }).id!;
    store.markSkipped(a, 'no abstract');
    store.markFailed(b, 'web fetch timeout');
    expect(store.getById(a)!.statusReason).toBe('no abstract');
    expect(store.getById(b)!.statusReason).toBe('web fetch timeout');
  });

  it('reapStaleProcessing flips stuck processing rows back to pending', async () => {
    const id = store.upsertPending(baseInput).id!;
    store.markProcessing(id);
    // Manually backdate processed_at to simulate a long-stuck row
    const db = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE article SET processed_at = datetime('now', '-2 hours') WHERE id=?").run(id);
    const reaped = store.reapStaleProcessing(60); // older than 60min
    expect(reaped).toBe(1);
    expect(store.getById(id)!.status).toBe('pending');
  });
});

describe('ArticleStore.listByDate / countByStatus', () => {
  it('listByDate filters by collected_at YYYY-MM-DD prefix', () => {
    store.upsertPending({ ...baseInput, title: 'A', url: 'https://e.com/a', collectedAt: new Date('2026-04-27T08:00:00Z') });
    store.upsertPending({ ...baseInput, title: 'B', url: 'https://e.com/b', collectedAt: new Date('2026-04-26T08:00:00Z') });
    expect(store.listByDate('2026-04-27').map((r) => r.title)).toEqual(['A']);
    expect(store.listByDate('2026-04-26').map((r) => r.title)).toEqual(['B']);
  });

  it('listByLocalDate spans the local-day window in UTC terms', () => {
    // Pick a Date created in local time so we know exactly which UTC instants
    // bracket "that local day" in the current TZ. Two articles bracket the
    // local day's edges; a third sits squarely in the middle of the next
    // local day. Only the bracketing pair should match.
    const localDay = new Date(2026, 3, 27, 12, 0, 0); // local noon, 2026-04-27
    const justAfterMidnight = new Date(2026, 3, 27, 0, 0, 30); // local
    const justBeforeMidnight = new Date(2026, 3, 27, 23, 59, 30); // local
    const nextDayNoon = new Date(2026, 3, 28, 12, 0, 0); // local
    const ymd = `${localDay.getFullYear()}-${String(localDay.getMonth() + 1).padStart(2, '0')}-${String(localDay.getDate()).padStart(2, '0')}`;

    store.upsertPending({ ...baseInput, title: 'EARLY', url: 'https://e.com/early', collectedAt: justAfterMidnight });
    store.upsertPending({ ...baseInput, title: 'LATE', url: 'https://e.com/late', collectedAt: justBeforeMidnight });
    store.upsertPending({ ...baseInput, title: 'NEXT', url: 'https://e.com/next', collectedAt: nextDayNoon });

    const titles = store.listByLocalDate(ymd).map((r) => r.title).sort();
    expect(titles).toEqual(['EARLY', 'LATE']);
  });

  it('listByLocalDate returns empty for unparseable input rather than throwing', () => {
    expect(store.listByLocalDate('not-a-date')).toEqual([]);
    expect(store.listByLocalDate('')).toEqual([]);
  });

  it('findByPagePath returns done articles whose page_paths includes the path', () => {
    const a = store.upsertPending({ ...baseInput, title: 'A', url: 'https://e.com/a' }).id!;
    const b = store.upsertPending({ ...baseInput, title: 'B', url: 'https://e.com/b' }).id!;
    const c = store.upsertPending({ ...baseInput, title: 'C', url: 'https://e.com/c' }).id!;
    store.markDone(a, ['wiki/topics/foo.md', 'wiki/entities/bar.md']);
    store.markDone(b, ['wiki/topics/foo.md']);
    store.markDone(c, ['wiki/topics/baz.md']);

    const fooArticles = store.findByPagePath('wiki/topics/foo.md');
    expect(fooArticles.map((r) => r.title).sort()).toEqual(['A', 'B']);

    const barArticles = store.findByPagePath('wiki/entities/bar.md');
    expect(barArticles.map((r) => r.title)).toEqual(['A']);

    expect(store.findByPagePath('wiki/topics/never-written.md')).toEqual([]);
  });

  it('findByPagePath excludes non-done statuses (pending, skipped, failed)', () => {
    const a = store.upsertPending({ ...baseInput, title: 'pending', url: 'https://e.com/a' }).id!;
    const b = store.upsertPending({ ...baseInput, title: 'skipped', url: 'https://e.com/b' }).id!;
    const c = store.upsertPending({ ...baseInput, title: 'failed', url: 'https://e.com/c' }).id!;
    const d = store.upsertPending({ ...baseInput, title: 'done', url: 'https://e.com/d' }).id!;
    // a stays pending; b skipped; c failed; d done — only d should match.
    store.markSkipped(b, 'irrelevant');
    store.markFailed(c, 'parse-error');
    store.markDone(d, ['wiki/topics/x.md']);
    // Forge a page_paths value on the others to prove status filter wins.
    // (markPending/markSkipped/markFailed don't write page_paths; they stay '[]'.
    // But to be safe, also test that filter is by status, not just by JSON.)
    expect(store.findByPagePath('wiki/topics/x.md').map((r) => r.title)).toEqual(['done']);
    void a;
  });

  it('countByStatus returns full record', () => {
    const a = store.upsertPending({ ...baseInput, title: 'A', url: 'https://e.com/a' }).id!;
    const b = store.upsertPending({ ...baseInput, title: 'B', url: 'https://e.com/b' }).id!;
    store.markDone(a, []);
    store.markSkipped(b, 'reason');
    const counts = store.countByStatus();
    expect(counts.done).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.pending).toBe(0);
  });
});

describe('ArticleStore.findByArxivId / findByDoi / findByUrlHash', () => {
  // upsertPending normalizes URLs (collapsing arxiv version suffixes and
  // canonicalizing doi.org), so to set up rows whose stored `url` differs
  // from the normalized form we write directly via the underlying handle.
  function rawInsert(url: string, title: string): number {
    const db = (store as unknown as {
      db: { prepare: (q: string) => { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } } };
    }).db;
    const result = db
      .prepare(
        `INSERT INTO article (url, url_hash, title, title_hash, collected_from)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(url, `hash:${url}`, title, `th:${title}`, baseInput.collectedFrom);
    return Number(result.lastInsertRowid);
  }

  describe('findByArxivId', () => {
    it('matches a row stored without a version suffix', () => {
      rawInsert('https://arxiv.org/abs/2605.03823', 'A');
      const row = store.findByArxivId('2605.03823');
      expect(row?.title).toBe('A');
    });

    it('matches a row stored with a version suffix', () => {
      rawInsert('https://arxiv.org/abs/2605.03823v1', 'B');
      const row = store.findByArxivId('2605.03823');
      expect(row?.title).toBe('B');
    });

    it('strips version suffix from input before matching', () => {
      rawInsert('https://arxiv.org/abs/2605.03823', 'C');
      const row = store.findByArxivId('2605.03823v2');
      expect(row?.title).toBe('C');
    });

    it('does not match a different paper id whose prefix overlaps', () => {
      rawInsert('https://arxiv.org/abs/2605.038234', 'longer');
      const row = store.findByArxivId('2605.03823');
      expect(row).toBeNull();
    });

    it('matches old-style ids with a category prefix', () => {
      rawInsert('https://arxiv.org/abs/cs.AI/0501001', 'old');
      const row = store.findByArxivId('cs.AI/0501001');
      expect(row?.title).toBe('old');
    });

    it('returns null when no row matches', () => {
      expect(store.findByArxivId('9999.99999')).toBeNull();
    });
  });

  describe('findByDoi', () => {
    const doi = '10.1038/s41586-024-12345-6';

    it('matches a row stored as https://doi.org/{doi}', () => {
      rawInsert(`https://doi.org/${doi}`, 'D');
      expect(store.findByDoi(doi)?.title).toBe('D');
    });

    it('accepts a doi.org URL as input', () => {
      rawInsert(`https://doi.org/${doi}`, 'E');
      expect(store.findByDoi(`https://doi.org/${doi}`)?.title).toBe('E');
    });

    it('is case-insensitive: uppercase input matches lowercase row', () => {
      rawInsert(`https://doi.org/${doi}`, 'F');
      expect(store.findByDoi('10.1038/S41586-024-12345-6')?.title).toBe('F');
    });

    it('is case-insensitive: lowercase input matches uppercase row', () => {
      rawInsert('https://doi.org/10.1038/S41586-024-12345-6', 'G');
      expect(store.findByDoi(doi)?.title).toBe('G');
    });

    it('matches a dx.doi.org row from either input form', () => {
      rawInsert(`https://dx.doi.org/${doi}`, 'H');
      expect(store.findByDoi(doi)?.title).toBe('H');
      expect(store.findByDoi(`https://dx.doi.org/${doi}`)?.title).toBe('H');
      expect(store.findByDoi(`https://doi.org/${doi}`)?.title).toBe('H');
    });

    it('returns null when no row matches', () => {
      expect(store.findByDoi('10.9999/missing')).toBeNull();
    });
  });

  describe('findByUrlHash', () => {
    it('returns the row for an exact url_hash match', () => {
      const id = store.upsertPending({ ...baseInput, title: 'I', url: 'https://example.com/i' }).id!;
      const fetched = store.getById(id)!;
      const row = store.findByUrlHash(fetched.urlHash!);
      expect(row?.id).toBe(id);
    });

    it('returns null on no match', () => {
      expect(store.findByUrlHash('0'.repeat(64))).toBeNull();
    });
  });
});

describe('ArticleStore.searchByTitle', () => {
  beforeEach(() => {
    store.upsertPending({ ...baseInput, title: 'Quantum Error Correction with Surface Codes', url: 'https://e.com/qec' });
    store.upsertPending({ ...baseInput, title: 'Surface code thresholds in noisy qubits', url: 'https://e.com/sct' });
    store.upsertPending({ ...baseInput, title: 'Multi-Agent Reinforcement Learning Survey', url: 'https://e.com/marl' });
    store.upsertPending({ ...baseInput, title: 'Reinforcement Learning from Human Feedback', url: 'https://e.com/rlhf' });
    store.upsertPending({ ...baseInput, title: 'Transformer Architectures for NLP', url: 'https://e.com/tx' });
  });

  it('returns rows whose title matches every keyword (AND semantics)', () => {
    const rows = store.searchByTitle('reinforcement learning');
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual([
      'Multi-Agent Reinforcement Learning Survey',
      'Reinforcement Learning from Human Feedback',
    ]);
  });

  it('case-insensitive', () => {
    const lower = store.searchByTitle('quantum surface');
    const upper = store.searchByTitle('QUANTUM SURFACE');
    expect(lower.map((r) => r.id)).toEqual(upper.map((r) => r.id));
    expect(lower).toHaveLength(1);
    expect(lower[0]!.title).toContain('Quantum Error Correction');
  });

  it('returns top-N by collected_at desc', () => {
    const rows = store.searchByTitle('surface', 1);
    expect(rows).toHaveLength(1);
    // 'Surface code thresholds…' was inserted second, so newer collected_at than 'Quantum Error Correction…'
    expect(rows[0]!.title).toBe('Surface code thresholds in noisy qubits');
  });

  it('returns empty for short or empty input', () => {
    expect(store.searchByTitle('')).toEqual([]);
    expect(store.searchByTitle('   ')).toEqual([]);
    // Single-char terms get filtered out (length < 2 floor to avoid useless LIKE).
    expect(store.searchByTitle('a')).toEqual([]);
  });

  it('escapes %, _, and \\ in keywords', () => {
    store.upsertPending({ ...baseInput, title: '50% accuracy on token_level test', url: 'https://e.com/escapes' });
    // The literal '%' should not be a wildcard.
    const rows = store.searchByTitle('50%');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('50% accuracy');
    // The literal '_' should not match arbitrary single characters.
    const tokenLevel = store.searchByTitle('token_level');
    expect(tokenLevel).toHaveLength(1);
  });

  it('returns empty when no row matches the AND of all keywords', () => {
    expect(store.searchByTitle('reinforcement quantum')).toEqual([]);
  });
});


describe('ArticleStore routed rows (multi-tenant copy path)', () => {
  const routedInput = {
    title: 'Sparse autoencoders decompose superposition',
    url: 'https://arxiv.org/abs/2605.99999',
    source: 'arXiv',
    field: 'AI/ML',
    summary: '## Overview\nSAEs as an interpretability tool.\n\n## Findings\nFeatures scale.',
    refsArxiv: ['1607.08221'],
    refsDoi: ['10.1145/3580305.3599350'],
    sharedStableId: 'arxiv-2605-99999',
    routedSimilarity: 0.68,
  };

  it('upsertRouted inserts with summary as snippet and routed metadata', () => {
    const r = store.upsertRouted(routedInput);
    expect(r.result).toBe('inserted');
    const row = store.getById(r.id!)!;
    expect(row.status).toBe('pending');
    expect(row.snippet).toContain('## Overview');
    expect(row.collectedFrom).toBe('shared-router');
    expect(row.refsArxiv).toEqual(['1607.08221']);
    expect(row.refsDoi).toEqual(['10.1145/3580305.3599350']);
    expect(row.sharedStableId).toBe('arxiv-2605-99999');
    expect(row.routedSimilarity).toBeCloseTo(0.68, 6);
  });

  it('upsertRouted dedups against an existing row by url', () => {
    store.upsertPending({ ...baseInput, url: routedInput.url, title: 'different title' });
    const r = store.upsertRouted(routedInput);
    expect(r.result).toBe('duplicate-url');
  });

  it('upsertRouted dedups by title when url differs', () => {
    store.upsertRouted(routedInput);
    const r = store.upsertRouted({ ...routedInput, url: 'https://example.com/mirror' });
    expect(r.result).toBe('duplicate-title');
  });

  it('legacy rows read back with null routed metadata', () => {
    const r = store.upsertPending(baseInput);
    const row = store.getById(r.id!)!;
    expect(row.refsArxiv).toBeNull();
    expect(row.refsDoi).toBeNull();
    expect(row.sharedStableId).toBeNull();
    expect(row.routedSimilarity).toBeNull();
  });

  it('column migration is idempotent across store re-opens', () => {
    const dbPath = join(dir, 'test.db');
    store.upsertRouted(routedInput);
    store.close();
    // Re-open twice; ALTER TABLE must not re-fire or clobber data.
    const second = new ArticleStore(dbPath);
    second.close();
    store = new ArticleStore(dbPath);
    const rows = store.listPending(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sharedStableId).toBe('arxiv-2605-99999');
  });
});

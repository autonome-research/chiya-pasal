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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArticleStore } from '../src/shared/article-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
let store: ArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-as-repair-'));
  store = new ArticleStore(join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  title: 'T',
  url: null as string | null,
  source: 'RSS',
  field: 'AI/ML',
  snippet: 'a snippet',
  collectedFrom: 'raw/inbox/2026-05-01-articles.md',
};

function seed(title: string, url: string): number {
  return store.upsertPending({ ...base, title, url }).id!;
}

describe('ArticleStore.requeueByStatus', () => {
  it('resets failed rows to pending, clears reason + processed_at, keeps page_paths', () => {
    const a = seed('A', 'https://e.com/a');
    const b = seed('B', 'https://e.com/b');
    const c = seed('C', 'https://e.com/c');
    store.markDone(a, ['wiki/sources/url-aaa.md']);
    store.markFailed(a, 'timeout while summarizing');
    store.markFailed(b, 'other-problem');
    store.markSkipped(c, 'already-ingested');

    const n = store.requeueByStatus({ status: 'failed' });
    expect(n).toBe(2);

    const rowA = store.getById(a)!;
    expect(rowA.status).toBe('pending');
    expect(rowA.statusReason).toBeNull();
    expect(rowA.processedAt).toBeNull();
    // page_paths untouched — the librarian's exists-check dedups.
    expect(rowA.pagePaths).toEqual(['wiki/sources/url-aaa.md']);

    expect(store.getById(b)!.status).toBe('pending');
    expect(store.getById(c)!.status).toBe('skipped'); // other statuses untouched
  });

  it('filters by likeReason when given', () => {
    const a = seed('A', 'https://e.com/a');
    const b = seed('B', 'https://e.com/b');
    store.markFailed(a, 'timeout while summarizing');
    store.markFailed(b, 'other-problem');

    const n = store.requeueByStatus({ status: 'failed', likeReason: '%timeout%' });
    expect(n).toBe(1);
    expect(store.getById(a)!.status).toBe('pending');
    expect(store.getById(b)!.status).toBe('failed');
  });

  it('requeues skipped rows when asked', () => {
    const a = seed('A', 'https://e.com/a');
    store.markSkipped(a, 'no-url-no-stable-id');
    expect(store.requeueByStatus({ status: 'skipped' })).toBe(1);
    expect(store.getById(a)!.status).toBe('pending');
  });
});

describe('ArticleStore.reasonHistogram', () => {
  it('groups by reason, most frequent first, honoring likeReason', () => {
    const ids = [seed('A', 'https://e.com/a'), seed('B', 'https://e.com/b'), seed('C', 'https://e.com/c')];
    store.markFailed(ids[0]!, 'timeout');
    store.markFailed(ids[1]!, 'timeout');
    store.markFailed(ids[2]!, 'other');

    expect(store.reasonHistogram({ status: 'failed' })).toEqual([
      { reason: 'timeout', count: 2 },
      { reason: 'other', count: 1 },
    ]);
    expect(store.reasonHistogram({ status: 'failed', likeReason: '%other%' })).toEqual([
      { reason: 'other', count: 1 },
    ]);
    expect(store.reasonHistogram({ status: 'skipped' })).toEqual([]);
  });
});

describe('ArticleStore.resetToPending', () => {
  it('clears page_paths, status_reason, and processed_at', () => {
    const a = seed('A', 'https://e.com/a');
    store.markDone(a, ['wiki/sources/url-aaa.md', 'wiki/topics/x.md']);
    store.resetToPending(a);
    const row = store.getById(a)!;
    expect(row.status).toBe('pending');
    expect(row.pagePaths).toEqual([]);
    expect(row.statusReason).toBeNull();
    expect(row.processedAt).toBeNull();
  });
});

describe('ArticleStore.deleteById', () => {
  it('removes the row and frees its dedup hashes for re-ingestion', () => {
    const a = seed('A', 'https://e.com/a');
    store.deleteById(a);
    expect(store.getById(a)).toBeNull();
    // Same URL + title now inserts cleanly instead of dedup-skipping.
    expect(store.upsertPending({ ...base, title: 'A', url: 'https://e.com/a' }).result).toBe('inserted');
  });
});

describe('ArticleStore.findByUrl', () => {
  it('matches through the same normalization as the upsert dedup', () => {
    const a = seed('Arxiv Paper', 'https://arxiv.org/abs/2605.11111v1');
    const found = store.findByUrl('http://arxiv.org/pdf/2605.11111v3.pdf');
    expect(found?.id).toBe(a);
    expect(store.findByUrl('https://arxiv.org/abs/2605.99999')).toBeNull();
  });
});

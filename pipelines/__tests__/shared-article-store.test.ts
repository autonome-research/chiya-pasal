import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SharedArticleStore } from '../src/shared/shared-article-store.js';

let dir: string;
let store: SharedArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-shared-'));
  store = new SharedArticleStore(join(dir, 'articles.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseInput = {
  stableId: 'arxiv-2403-12834',
  url: 'https://arxiv.org/abs/2403.12834',
  title: 'On the geometry of representation spaces',
  source: 'arXiv',
  field: 'AI/ML',
  queryLabels: ['ai-ml'],
  abstract: 'We study the geometry of representation spaces of deep networks.',
};

describe('SharedArticleStore.upsertCollected', () => {
  it('inserts a new article and sets status=pending', () => {
    const result = store.upsertCollected(baseInput);
    expect(result).toBe('inserted');
    const row = store.findByStableId(baseInput.stableId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.queryLabels).toEqual(['ai-ml']);
  });

  it('rejects a duplicate by url_hash and merges new query labels', () => {
    store.upsertCollected(baseInput);
    const result = store.upsertCollected({
      ...baseInput,
      stableId: 'should-be-ignored',
      queryLabels: ['robotics'],
    });
    expect(result).toBe('duplicate');
    const row = store.findByStableId(baseInput.stableId);
    expect(row!.queryLabels.sort()).toEqual(['ai-ml', 'robotics']);
  });

  it('does not double-add the same query label on re-collection', () => {
    store.upsertCollected(baseInput);
    store.upsertCollected(baseInput);
    const row = store.findByStableId(baseInput.stableId);
    expect(row!.queryLabels).toEqual(['ai-ml']);
  });
});

describe('SharedArticleStore lifecycle transitions', () => {
  beforeEach(() => {
    store.upsertCollected(baseInput);
  });

  it('markEnriched stores fulltext + refs and transitions status', () => {
    store.markEnriched(
      baseInput.stableId,
      'full body of paper goes here',
      ['1607.08221'],
      ['10.1145/3580305.3599350'],
    );
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('enriched');
    expect(row.fulltext).toBe('full body of paper goes here');
    expect(row.refsArxiv).toEqual(['1607.08221']);
    expect(row.refsDoi).toEqual(['10.1145/3580305.3599350']);
    expect(row.enrichedAt).not.toBeNull();
  });

  it('markEnrichFailed records reason and transitions status', () => {
    store.markEnrichFailed(baseInput.stableId, 'http 404');
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('enrich-failed');
    expect(row.statusReason).toBe('http 404');
  });

  it('markSummarized stores summary and transitions status', () => {
    store.markEnriched(baseInput.stableId, 'body', [], []);
    store.markSummarized(baseInput.stableId, 'rich summary text');
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('summarized');
    expect(row.summary).toBe('rich summary text');
    expect(row.summarizedAt).not.toBeNull();
  });

  it('markEmbedded round-trips the vector via Float32 BLOB', () => {
    store.markEnriched(baseInput.stableId, 'body', [], []);
    store.markSummarized(baseInput.stableId, 'summary');
    const vec = [0.1, 0.2, 0.3, -0.4, 1.5e-3];
    store.markEmbedded(baseInput.stableId, vec);
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('embedded');
    expect(row.summaryEmbedding).toHaveLength(vec.length);
    // Float32 quantization — verify within tolerance, not exact equality.
    row.summaryEmbedding!.forEach((v, i) => {
      expect(v).toBeCloseTo(vec[i]!, 5);
    });
  });

  it('markRouted transitions to terminal status and stamps routed_at', () => {
    store.markEnriched(baseInput.stableId, 'body', [], []);
    store.markSummarized(baseInput.stableId, 'summary');
    store.markEmbedded(baseInput.stableId, [0]);
    store.markRouted(baseInput.stableId);
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('routed');
    expect(row.routedAt).not.toBeNull();
  });

  it('markFailed records reason and transitions status', () => {
    store.markFailed(baseInput.stableId, 'summarizer truncated 3x');
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('failed');
    expect(row.statusReason).toBe('summarizer truncated 3x');
  });
});

describe('SharedArticleStore.listByStatus + countByStatus', () => {
  it('listByStatus returns oldest-first up to limit', () => {
    for (let i = 0; i < 5; i++) {
      store.upsertCollected({
        ...baseInput,
        stableId: `id-${i}`,
        url: `https://example.com/${i}`,
      });
    }
    const batch = store.listByStatus('pending', 3);
    expect(batch).toHaveLength(3);
    expect(batch.map((r) => r.stableId)).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('listByStatus filters by status', () => {
    store.upsertCollected(baseInput);
    store.upsertCollected({ ...baseInput, stableId: 'id-2', url: 'https://x.com/2' });
    store.markEnriched(baseInput.stableId, 'body', [], []);

    const pending = store.listByStatus('pending', 10);
    expect(pending.map((r) => r.stableId)).toEqual(['id-2']);
    const enriched = store.listByStatus('enriched', 10);
    expect(enriched.map((r) => r.stableId)).toEqual([baseInput.stableId]);
  });

  it('countByStatus reports all status buckets including empty ones', () => {
    store.upsertCollected(baseInput);
    store.upsertCollected({ ...baseInput, stableId: 'id-2', url: 'https://x.com/2' });
    store.markEnriched(baseInput.stableId, 'body', [], []);

    const counts = store.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.enriched).toBe(1);
    expect(counts.routed).toBe(0); // empty bucket explicitly present
    expect(counts.failed).toBe(0);
  });
});

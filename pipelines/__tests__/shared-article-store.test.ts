import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { isTransientFailureReason, SharedArticleStore } from '../src/shared/shared-article-store.js';

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

  it('same stable_id with a different url (arXiv version bump) is a duplicate, not a crash', () => {
    store.upsertCollected(baseInput);
    // v2 URL: different url_hash, same stable_id — the live crash-loop case.
    const result = store.upsertCollected({
      ...baseInput,
      url: 'https://arxiv.org/abs/2403.12834v2',
      queryLabels: ['robotics'],
    });
    expect(result).toBe('duplicate');
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.url).toBe(baseInput.url); // original row untouched
    expect(row.queryLabels.sort()).toEqual(['ai-ml', 'robotics']);
    expect(store.listByStatus('pending', 10)).toHaveLength(1);
  });

  it('new row starts with zero summarize attempts', () => {
    store.upsertCollected(baseInput);
    expect(store.findByStableId(baseInput.stableId)!.summarizeAttempts).toBe(0);
  });

  it('column migration is idempotent across re-opens', () => {
    store.upsertCollected(baseInput);
    store.incrementSummarizeAttempts(baseInput.stableId);
    const path = join(dir, 'articles.db');
    const reopened = new SharedArticleStore(path);
    try {
      expect(reopened.findByStableId(baseInput.stableId)!.summarizeAttempts).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe('SharedArticleStore.incrementSummarizeAttempts', () => {
  it('increments and returns the running total', () => {
    store.upsertCollected(baseInput);
    expect(store.incrementSummarizeAttempts(baseInput.stableId)).toBe(1);
    expect(store.incrementSummarizeAttempts(baseInput.stableId)).toBe(2);
    expect(store.findByStableId(baseInput.stableId)!.summarizeAttempts).toBe(2);
  });

  it('returns 0 for an unknown stable_id', () => {
    expect(store.incrementSummarizeAttempts('nope')).toBe(0);
  });
});

describe('isTransientFailureReason', () => {
  it.each([
    'summarize: summary missing section structure (starts: {"_error":true,"message":"Connection error."})',
    'ETIMEDOUT while contacting host',
    'request timed out after 60s',
    '502 Bad Gateway',
    'Request failed with status code 503',
    'HTTP 429 rate limit exceeded',
    '408 Request Timeout',
    'socket hang up',
    'the provider is overloaded',
  ])('transient: %s', (reason) => {
    expect(isTransientFailureReason(reason)).toBe(true);
  });

  it.each([
    'summarize: summary missing section structure (starts: {"_error":true,"message":"400 TextEncodeInput must be Union[)',
    'summary missing section structure (starts: This paper is about)',
    'no-text: neither fulltext nor abstract',
    'summary truncated: model exhausted its output budget',
  ])('terminal: %s', (reason) => {
    expect(isTransientFailureReason(reason)).toBe(false);
  });
});

describe('SharedArticleStore.requeueTransientFailures', () => {
  const TRANSIENT =
    'summarize: summary missing section structure (starts: {"_error":true,"message":"Connection error."})';

  function seedFailed(stableId: string, opts: { fulltext: boolean; reason: string }): void {
    store.upsertCollected({ ...baseInput, stableId, url: `https://example.com/${stableId}` });
    if (opts.fulltext) store.markEnriched(stableId, 'body', [], []);
    else store.markEnrichFailed(stableId, 'fetch failed');
    store.incrementSummarizeAttempts(stableId);
    store.markFailed(stableId, opts.reason);
  }

  it('restores transient failures to their pre-summarize status and resets attempts', () => {
    seedFailed('had-text', { fulltext: true, reason: TRANSIENT });
    seedFailed('no-fulltext', { fulltext: false, reason: TRANSIENT });
    seedFailed('terminal-400', {
      fulltext: true,
      reason: 'summarize: summary missing section structure (starts: {"_error":true,"message":"400 TextEncodeInput must be Union[)',
    });
    seedFailed('terminal-notext', { fulltext: false, reason: 'no-text: neither fulltext nor abstract' });

    const count = store.requeueTransientFailures();
    expect(count).toBe(2);

    const hadText = store.findByStableId('had-text')!;
    expect(hadText.status).toBe('enriched'); // fulltext present → came from enriched
    expect(hadText.statusReason).toBeNull();
    expect(hadText.summarizeAttempts).toBe(0);

    const noFull = store.findByStableId('no-fulltext')!;
    expect(noFull.status).toBe('enrich-failed'); // abstract-fallback path preserved
    expect(noFull.summarizeAttempts).toBe(0);

    expect(store.findByStableId('terminal-400')!.status).toBe('failed');
    expect(store.findByStableId('terminal-notext')!.status).toBe('failed');
  });

  it('is a no-op when nothing failed transiently', () => {
    store.upsertCollected(baseInput);
    expect(store.requeueTransientFailures()).toBe(0);
    expect(store.findByStableId(baseInput.stableId)!.status).toBe('pending');
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
    store.markSummarized(baseInput.stableId, 'rich summary text', { rigor: 4, evidence: 3, kind: 'research' });
    const row = store.findByStableId(baseInput.stableId)!;
    expect(row.status).toBe('summarized');
    expect(row.summary).toBe('rich summary text');
    expect(row.summarizedAt).not.toBeNull();
  });

  it('markEmbedded round-trips the vector via Float32 BLOB', () => {
    store.markEnriched(baseInput.stableId, 'body', [], []);
    store.markSummarized(baseInput.stableId, 'summary', null);
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
    store.markSummarized(baseInput.stableId, 'summary', null);
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

describe('SharedArticleStore routing telemetry', () => {
  const decisions = [
    { stableId: 'a1', userHandle: 'alice', similarity: 0.72, routed: true, viaFloor: false },
    { stableId: 'a1', userHandle: 'bob', similarity: 0.31, routed: false, viaFloor: false },
    { stableId: 'a2', userHandle: 'alice', similarity: 0.44, routed: true, viaFloor: true },
  ];

  it('logs a routing pass and reads it back with typed fields', () => {
    store.logRoutingDecisions(decisions);
    const rows = store.routingSimilarities();
    expect(rows).toHaveLength(3);
    const floored = rows.find((r) => r.stableId === 'a2')!;
    expect(floored.routed).toBe(true);
    expect(floored.viaFloor).toBe(true);
    expect(floored.similarity).toBeCloseTo(0.44, 6);
    expect(floored.decidedAt).toBeInstanceOf(Date);
  });

  it('filters by userHandle', () => {
    store.logRoutingDecisions(decisions);
    const bobRows = store.routingSimilarities({ userHandle: 'bob' });
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.routed).toBe(false);
  });

  it('respects the limit option', () => {
    store.logRoutingDecisions(decisions);
    expect(store.routingSimilarities({ limit: 2 })).toHaveLength(2);
  });

  it('sinceDays window excludes older rows', () => {
    store.logRoutingDecisions(decisions);
    // Everything just inserted is within 1 day.
    expect(store.routingSimilarities({ sinceDays: 1 })).toHaveLength(3);
  });

  it('empty decisions array is a no-op', () => {
    store.logRoutingDecisions([]);
    expect(store.routingSimilarities()).toHaveLength(0);
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

describe('SharedArticleStore citation demand ledger', () => {
  const entry = {
    userHandle: 'alice',
    refKind: 'arxiv' as const,
    refId: '1607.08221',
    citingStableId: 'arxiv-2606-11111',
  };

  it('records demand and aggregates by distinct citing articles', () => {
    store.recordCitationDemand([
      entry,
      { ...entry, citingStableId: 'arxiv-2606-22222' },
      { ...entry, refId: '10.1/x', refKind: 'doi', citingStableId: 'arxiv-2606-11111' },
    ]);
    const summary = store.citationDemandSummary({ userHandle: 'alice' });
    expect(summary).toHaveLength(2);
    const wanted = summary[0]!; // sorted by demand desc
    expect(wanted.refId).toBe('1607.08221');
    expect(wanted.demandCount).toBe(2);
    expect(wanted.citers.sort()).toEqual(['arxiv-2606-11111', 'arxiv-2606-22222']);
  });

  it('re-recording the same pair is idempotent', () => {
    store.recordCitationDemand([entry]);
    store.recordCitationDemand([entry]);
    const summary = store.citationDemandSummary({ userHandle: 'alice' });
    expect(summary[0]!.demandCount).toBe(1);
  });

  it('minCount filters below-threshold demand (the tier-3 trigger query)', () => {
    store.recordCitationDemand([
      entry,
      { ...entry, citingStableId: 'arxiv-2606-22222' },
      { ...entry, refId: 'lonely.00001', citingStableId: 'arxiv-2606-11111' },
    ]);
    const hot = store.citationDemandSummary({ userHandle: 'alice', minCount: 2 });
    expect(hot).toHaveLength(1);
    expect(hot[0]!.refId).toBe('1607.08221');
  });

  it('demand is scoped per user', () => {
    store.recordCitationDemand([entry, { ...entry, userHandle: 'bob' }]);
    expect(store.citationDemandSummary({ userHandle: 'alice' })).toHaveLength(1);
    expect(store.citationDemandSummary({ userHandle: 'bob' })).toHaveLength(1);
  });
});

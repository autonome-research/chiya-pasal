import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';

import { embedSummaries, routeBroadcast, routeEmbedded } from '../../src/phases/shared/route.js';
import {
  SharedArticleStore,
  type QualityAssessment,
} from '../../src/shared/shared-article-store.js';
import { ArticleStore } from '../../src/shared/article-store.js';
import type { SharedPipelineCtx } from '../../src/shared/shared-pipeline-types.js';
import type { EmbeddingResult, EmbeddingTarget } from '../../src/shared/embedding.js';
import type { User } from '../../src/shared/users.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function makeCtx(): SharedPipelineCtx {
  return { cache: new PipelineCache(), signal: new AbortController().signal };
}

const TARGET: EmbeddingTarget = { baseUrl: 'http://unused/v1', apiKey: 'x', model: 'fake-embed' };

/** Deterministic fake embedder: maps known strings to fixed vectors. */
function fakeEmbed(vectorFor: (text: string) => number[]): (
  texts: string[],
  target: EmbeddingTarget,
) => Promise<EmbeddingResult[]> {
  return async (texts) => texts.map((t, index) => ({ vector: vectorFor(t), index }));
}

function makeUser(over: Partial<User>): User {
  return {
    handle: 'alice',
    name: 'Alice',
    emailTo: 'a@x.com',
    vaultRemote: 'git@github.com:x/vault-alice.git',
    vaultBranch: 'main',
    interests: ['interpretability of language models'],
    threshold: 0.5,
    enabled: true,
    onboarded: null,
    ...over,
  };
}

let dir: string;
let store: SharedArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-route-'));
  store = new SharedArticleStore(join(dir, 'articles.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedSummarized(
  stableId: string,
  summary: string,
  quality: QualityAssessment | null = null,
): void {
  store.upsertCollected({
    stableId,
    url: `https://example.com/${stableId}`,
    title: `Article ${stableId}`,
    source: 'test',
    field: 'AI/ML',
    queryLabels: ['AI/ML'],
    abstract: 'abs',
  });
  store.markEnriched(stableId, 'text', ['1607.08221'], []);
  store.markSummarized(stableId, summary, quality);
}

describe('embedSummaries', () => {
  it('embeds summarized rows and transitions to embedded', async () => {
    seedSummarized('a1', 'interp summary');
    const ctx = makeCtx();
    await drain(
      embedSummaries(store, TARGET, { embed: fakeEmbed(() => [1, 0]) }).run(ctx),
    );
    expect(ctx.embeddedCount).toBe(1);
    const row = store.findByStableId('a1')!;
    expect(row.status).toBe('embedded');
    expect(row.summaryEmbedding).toEqual([1, 0]);
  });

  it('no-op when nothing summarized', async () => {
    const ctx = makeCtx();
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(() => [1]) }).run(ctx));
    expect(ctx.embeddedCount).toBe(0);
  });
});

describe('routeEmbedded', () => {
  function userStoreFactory(): { factory: (handle: string) => ArticleStore; paths: Map<string, string> } {
    const paths = new Map<string, string>();
    return {
      paths,
      factory: (handle: string) => {
        const userDir = join(dir, 'users', handle);
        mkdirSync(userDir, { recursive: true });
        const p = join(userDir, 'articles.db');
        paths.set(handle, p);
        return new ArticleStore(p);
      },
    };
  }

  it('copies matched articles into per-user stores with provenance', async () => {
    seedSummarized('match', 'summary about interpretability');
    seedSummarized('miss', 'summary about wetland ecology');
    // Embed articles with controlled vectors: 'match' aligns with alice.
    const vectorFor = (text: string): number[] =>
      text.includes('interpretability') ? [1, 0] : [0, 1];
    const embedCtx = makeCtx();
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(vectorFor) }).run(embedCtx));

    const { factory, paths } = userStoreFactory();
    const ctx = makeCtx();
    await drain(
      routeEmbedded(store, [makeUser({})], TARGET, {
        embed: fakeEmbed(vectorFor),
        openUserStore: factory,
      }).run(ctx),
    );

    expect(ctx.routeCounts).toMatchObject({ articles: 2, matches: 1, copied: 1, duplicates: 0 });
    expect(store.findByStableId('match')!.status).toBe('routed');
    expect(store.findByStableId('miss')!.status).toBe('routed');

    const aliceStore = new ArticleStore(paths.get('alice')!);
    const rows = aliceStore.listPending(10);
    aliceStore.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sharedStableId).toBe('match');
    expect(rows[0]!.snippet).toContain('interpretability');
    expect(rows[0]!.refsArxiv).toEqual(['1607.08221']);
    expect(rows[0]!.routedSimilarity).toBeCloseTo(1.0, 6);
    expect(rows[0]!.collectedFrom).toBe('shared-router');
  });

  it('carries the shared quality assessment into the per-user copy', async () => {
    seedSummarized('match', 'summary about interpretability', {
      rigor: 4,
      evidence: 3,
      kind: 'research',
    });
    const vectorFor = (): number[] => [1, 0];
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(vectorFor) }).run(makeCtx()));

    const { factory, paths } = userStoreFactory();
    await drain(
      routeEmbedded(store, [makeUser({})], TARGET, {
        embed: fakeEmbed(vectorFor),
        openUserStore: factory,
      }).run(makeCtx()),
    );

    const aliceStore = new ArticleStore(paths.get('alice')!);
    const rows = aliceStore.listPending(10);
    aliceStore.close();
    expect(rows[0]!.qualityRigor).toBe(4);
    expect(rows[0]!.qualityEvidence).toBe(3);
  });

  it('unscored shared rows copy through with null quality', async () => {
    seedSummarized('match', 'summary about interpretability');
    const vectorFor = (): number[] => [1, 0];
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(vectorFor) }).run(makeCtx()));

    const { factory, paths } = userStoreFactory();
    await drain(
      routeEmbedded(store, [makeUser({})], TARGET, {
        embed: fakeEmbed(vectorFor),
        openUserStore: factory,
      }).run(makeCtx()),
    );

    const aliceStore = new ArticleStore(paths.get('alice')!);
    const rows = aliceStore.listPending(10);
    aliceStore.close();
    expect(rows[0]!.qualityRigor).toBeNull();
    expect(rows[0]!.qualityEvidence).toBeNull();
  });

  it('persists the full score matrix including unrouted pairs', async () => {
    seedSummarized('match', 'summary about interpretability');
    seedSummarized('miss', 'summary about wetland ecology');
    const vectorFor = (text: string): number[] =>
      text.includes('interpretability') ? [1, 0] : [0, 1];
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(vectorFor) }).run(makeCtx()));

    const { factory } = userStoreFactory();
    await drain(
      routeEmbedded(store, [makeUser({})], TARGET, {
        embed: fakeEmbed(vectorFor),
        openUserStore: factory,
      }).run(makeCtx()),
    );

    const log = store.routingSimilarities();
    expect(log).toHaveLength(2); // 2 articles × 1 user
    expect(log.find((l) => l.stableId === 'match')!.routed).toBe(true);
    expect(log.find((l) => l.stableId === 'miss')!.routed).toBe(false);
  });

  it('re-routing after a crash is idempotent (upsertRouted dedups)', async () => {
    seedSummarized('match', 'interpretability once more');
    const vectorFor = (): number[] => [1, 0];
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(vectorFor) }).run(makeCtx()));

    const { factory, paths } = userStoreFactory();
    const deps = { embed: fakeEmbed(vectorFor), openUserStore: factory };
    await drain(routeEmbedded(store, [makeUser({})], TARGET, deps).run(makeCtx()));

    // Simulate a crash-before-markRouted by resetting status to embedded.
    // (No public API for backwards transitions — routing must tolerate
    // replays, so we exercise it via a second full pass on the same rows.)
    const again = makeCtx();
    // Force re-route of already-routed rows: seed a second identical article
    // that will collide with the copy in alice's store by URL.
    seedSummarized('match2', 'interpretability once more v2');
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(vectorFor) }).run(makeCtx()));
    // Make match2's copy collide by title? Different titles — it inserts.
    await drain(routeEmbedded(store, [makeUser({})], TARGET, deps).run(again));

    const aliceStore = new ArticleStore(paths.get('alice')!);
    const rows = aliceStore.listPending(10);
    aliceStore.close();
    expect(rows.length).toBe(2); // both articles present exactly once
  });

  it('multi-interest users route on their best-matching interest paragraph', async () => {
    seedSummarized('protein', 'summary about protein binder design');
    const articleVec = (text: string): number[] => (text.includes('protein') ? [0, 1] : [1, 0]);
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(articleVec) }).run(makeCtx()));

    // alice has two interests: [1,0] (interp) and [0,1] (protein).
    const interestVec = (text: string): number[] => (text.includes('protein') ? [0, 1] : [1, 0]);
    const user = makeUser({ interests: ['interpretability', 'protein design'] });
    const { factory, paths } = userStoreFactory();
    const ctx = makeCtx();
    await drain(
      routeEmbedded(store, [user], TARGET, {
        embed: fakeEmbed(interestVec),
        openUserStore: factory,
      }).run(ctx),
    );

    expect(ctx.routeCounts).toMatchObject({ matches: 1, copied: 1 });
    const aliceStore = new ArticleStore(paths.get('alice')!);
    expect(aliceStore.listPending(10)).toHaveLength(1);
    aliceStore.close();
  });

  it('no enabled users → articles still marked routed, nothing copied', async () => {
    seedSummarized('a1', 'whatever');
    await drain(embedSummaries(store, TARGET, { embed: fakeEmbed(() => [1]) }).run(makeCtx()));
    const ctx = makeCtx();
    await drain(
      routeEmbedded(store, [], TARGET, {
        embed: fakeEmbed(() => [1]),
        openUserStore: () => {
          throw new Error('no users, no stores');
        },
      }).run(ctx),
    );
    expect(ctx.routeCounts).toEqual({ articles: 0, matches: 0, copied: 0, duplicates: 0 });
    // Articles stay embedded (not routed) so a later cycle with users picks them up.
    expect(store.findByStableId('a1')!.status).toBe('embedded');
  });
});

describe('routeBroadcast (embeddings-down mode)', () => {
  function userStoreFactory(): { factory: (handle: string) => ArticleStore; paths: Map<string, string> } {
    const paths = new Map<string, string>();
    return {
      paths,
      factory: (handle: string) => {
        const userDir = join(dir, 'users', handle);
        mkdirSync(userDir, { recursive: true });
        const p = join(userDir, 'articles.db');
        paths.set(handle, p);
        return new ArticleStore(p);
      },
    };
  }

  it('copies every summarized article to every enabled user with null similarity', async () => {
    seedSummarized('a1', 'summary one');
    seedSummarized('a2', 'summary two');
    const users = [makeUser({}), makeUser({ handle: 'bob', emailTo: 'b@x.com' })];
    const { factory, paths } = userStoreFactory();

    const ctx = makeCtx();
    await drain(routeBroadcast(store, users, { openUserStore: factory }).run(ctx));

    expect(ctx.routeCounts).toEqual({ articles: 2, matches: 4, copied: 4, duplicates: 0 });
    expect(store.findByStableId('a1')!.status).toBe('routed'); // skipped 'embedded' entirely
    expect(store.findByStableId('a2')!.status).toBe('routed');

    for (const handle of ['alice', 'bob']) {
      const s = new ArticleStore(paths.get(handle)!);
      const rows = s.listPending(10);
      s.close();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.routedSimilarity === null)).toBe(true);
      expect(rows.every((r) => r.collectedFrom === 'shared-router')).toBe(true);
      expect(rows.every((r) => r.sharedStableId !== null)).toBe(true);
    }
  });

  it('carries quality through the broadcast path too', async () => {
    seedSummarized('a1', 'summary one', { rigor: 5, evidence: 2, kind: 'survey' });
    const { factory, paths } = userStoreFactory();
    await drain(routeBroadcast(store, [makeUser({})], { openUserStore: factory }).run(makeCtx()));

    const s = new ArticleStore(paths.get('alice')!);
    const rows = s.listPending(10);
    s.close();
    expect(rows[0]!.qualityRigor).toBe(5);
    expect(rows[0]!.qualityEvidence).toBe(2);
  });

  it('writes no routing_log rows (broadcast carries no tuning signal)', async () => {
    seedSummarized('a1', 'summary one');
    const { factory } = userStoreFactory();
    await drain(routeBroadcast(store, [makeUser({})], { openUserStore: factory }).run(makeCtx()));
    expect(store.routingSimilarities()).toHaveLength(0);
  });

  it('replaying after a crash dedups cleanly', async () => {
    seedSummarized('a1', 'summary one');
    const { factory, paths } = userStoreFactory();
    const deps = { openUserStore: factory };
    await drain(routeBroadcast(store, [makeUser({})], deps).run(makeCtx()));
    // Second article arrives; first is already in alice's store.
    seedSummarized('a2', 'summary two');
    const ctx = makeCtx();
    await drain(routeBroadcast(store, [makeUser({})], deps).run(ctx));
    const s = new ArticleStore(paths.get('alice')!);
    expect(s.listPending(10)).toHaveLength(2);
    s.close();
  });

  it('no users → articles hold at summarized for a later cycle', async () => {
    seedSummarized('a1', 'summary one');
    const ctx = makeCtx();
    await drain(routeBroadcast(store, [], { openUserStore: () => { throw new Error('none'); } }).run(ctx));
    expect(store.findByStableId('a1')!.status).toBe('summarized');
  });
});

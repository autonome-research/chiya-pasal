import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';

import { scanSharedInbox, absorbInbox } from '../../src/phases/shared/absorb.js';
import { SharedArticleStore } from '../../src/shared/shared-article-store.js';
import type { SharedPipelineCtx } from '../../src/shared/shared-pipeline-types.js';
import { VaultFs } from '../../src/tools/vault.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function makeCtx(): SharedPipelineCtx {
  return {
    cache: new PipelineCache(),
    signal: new AbortController().signal,
  };
}

const ARTICLES_MD = `---
date: 2026-06-28
---

# Raw Articles — 2026-06-28

#### AI/ML
- [Attention is all you need again](https://arxiv.org/abs/2606.11111) *(arXiv)* — Transformers revisited.
- [No URL possible](not a real url) *(Nowhere)*

#### Robotics
- [Legged locomotion survey](https://arxiv.org/abs/2606.22222) *(arXiv)*
`;

let dir: string;
let inboxFs: VaultFs;
let store: SharedArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-absorb-'));
  writeFileSync(join(dir, '2026-06-28-articles.md'), ARTICLES_MD);
  inboxFs = new VaultFs(dir);
  store = new SharedArticleStore(join(dir, 'articles.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scanSharedInbox + absorbInbox', () => {
  it('absorbs articles into the shared store with field-derived query labels', async () => {
    const ctx = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(ctx));
    expect(ctx.inboxFiles).toEqual(['2026-06-28-articles.md']);

    await drain(absorbInbox(inboxFs, store).run(ctx));
    expect(ctx.absorbCounts).toMatchObject({
      files: 1,
      parsed: 3,
      inserted: 2,
      duplicates: 0,
      skippedNoUrl: 1,
    });

    const pending = store.listByStatus('pending', 10);
    expect(pending).toHaveLength(2);
    const attention = pending.find((r) => r.title.startsWith('Attention'))!;
    expect(attention.stableId).toBe('arxiv-2606-11111');
    expect(attention.queryLabels).toEqual(['AI/ML']);
    expect(attention.abstract).toBe('Transformers revisited.');
  });

  it('archives the inbox file after absorbing', async () => {
    const ctx = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(ctx));
    await drain(absorbInbox(inboxFs, store).run(ctx));
    expect(existsSync(join(dir, '2026-06-28-articles.md'))).toBe(false);
    expect(existsSync(join(dir, 'archive', '2026-06-28-articles.md'))).toBe(true);
  });

  it('re-absorbing the same content is a dedup no-op', async () => {
    const first = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(first));
    await drain(absorbInbox(inboxFs, store).run(first));

    writeFileSync(join(dir, '2026-06-29-articles.md'), ARTICLES_MD);
    const second = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(second));
    await drain(absorbInbox(inboxFs, store).run(second));

    expect(second.absorbCounts).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(store.listByStatus('pending', 10)).toHaveLength(2);
  });

  it('empty inbox is a clean no-op', async () => {
    rmSync(join(dir, '2026-06-28-articles.md'));
    const ctx = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(ctx));
    await drain(absorbInbox(inboxFs, store).run(ctx));
    expect(ctx.absorbCounts).toMatchObject({ files: 0, parsed: 0 });
  });

  it('an arXiv version bump (same stable_id, new url) absorbs as duplicate and merges labels', async () => {
    // v1 already in the store (different url → different url_hash, SAME stable_id).
    store.upsertCollected({
      stableId: 'arxiv-2606-11111',
      url: 'http://arxiv.org/abs/2606.11111v1',
      title: 'Attention is all you need again',
      source: 'arXiv',
      field: 'NLP',
      queryLabels: ['NLP'],
      abstract: null,
    });

    const ctx = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(ctx));
    await drain(absorbInbox(inboxFs, store).run(ctx));

    // Must not throw SQLITE_CONSTRAINT_PRIMARYKEY; the v1 row absorbs the hit.
    expect(ctx.absorbCounts).toMatchObject({ inserted: 1, duplicates: 1, skippedError: 0 });
    const row = store.findByStableId('arxiv-2606-11111')!;
    expect(row.url).toBe('http://arxiv.org/abs/2606.11111v1');
    expect(row.queryLabels.sort()).toEqual(['AI/ML', 'NLP']);
    expect(existsSync(join(dir, 'archive', '2026-06-28-articles.md'))).toBe(true);
  });

  it('one poisoned article is skipped with an error count; the rest absorb and the file archives', async () => {
    const original = store.upsertCollected.bind(store);
    vi.spyOn(store, 'upsertCollected').mockImplementation((input) => {
      if (input.url.includes('2606.22222')) throw new Error('SQLITE_CONSTRAINT: boom');
      return original(input);
    });

    const ctx = makeCtx();
    await drain(scanSharedInbox(inboxFs).run(ctx));
    const events = await drain(absorbInbox(inboxFs, store).run(ctx));

    expect(ctx.absorbCounts).toMatchObject({ inserted: 1, duplicates: 0, skippedError: 1 });
    expect(store.findByStableId('arxiv-2606-11111')).not.toBeNull();
    expect(store.findByStableId('arxiv-2606-22222')).toBeNull();
    // File is archived after all rows were handled, even with a bad row.
    expect(existsSync(join(dir, '2026-06-28-articles.md'))).toBe(false);
    expect(existsSync(join(dir, 'archive', '2026-06-28-articles.md'))).toBe(true);
    // The phase event surfaces the error.
    const phase = events.find((e) => e.type === 'phase' && e.phase === 'absorb-inbox');
    expect(phase && 'detail' in phase ? phase.detail : '').toContain('SQLITE_CONSTRAINT: boom');
  });
});

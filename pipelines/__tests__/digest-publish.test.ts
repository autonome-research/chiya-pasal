import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';
import { describe, expect, it } from 'vitest';

import type { Article } from '../src/shared/article.js';
import type { DigestCtx } from '../src/shared/digest-types.js';
import { appendLog } from '../src/phases/digest/publish.js';
import { VaultFs } from '../src/tools/vault.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function ctx(partial: Partial<DigestCtx> = {}): DigestCtx {
  const article: Article = {
    title: 'A',
    url: 'https://example.com/a',
    source: 'test',
    field: 'AI',
    snippet: null,
    collectedAt: new Date('2026-06-03T00:00:00Z'),
  };
  return {
    cache: new PipelineCache(),
    direction: 'AM',
    date: '2026-06-03',
    signal: new AbortController().signal,
    articles: [article],
    classified: [{ article, bucket: 'focus', reason: 'interesting', wikilinks: [] }],
    ...partial,
  };
}

describe('digest publish phases', () => {
  it('appendLog is idempotent for the same date and direction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chiya-digest-log-'));
    mkdirSync(dir, { recursive: true });
    const vault = new VaultFs(dir);
    try {
      const c = ctx();
      await drain(appendLog(vault).run(c));
      await drain(appendLog(vault).run(c));
      const log = await vault.read('log.md');
      expect(log.match(/\[2026-06-03\] digest \| AM digest curated/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

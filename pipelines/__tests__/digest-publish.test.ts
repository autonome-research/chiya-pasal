import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { PipelineCache } from 'thread-phase';
import { describe, expect, it } from 'vitest';

import type { Article } from '../src/shared/article.js';
import type { DigestCtx } from '../src/shared/digest-types.js';
import type { ChiyaEnv } from '../src/shared/env.js';
import { appendLog, emailSend } from '../src/phases/digest/publish.js';
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

function makeEnv(): ChiyaEnv {
  return {
    vaultDir: '/tmp/vault',
    vaultRemote: 'origin',
    vaultBranch: 'main',
    emailTo: 'tea@example.com',
    fast: { baseUrl: 'http://localhost/v1', apiKey: 'x', model: 'fast' },
    tools: { baseUrl: 'http://localhost/v1', apiKey: 'x', model: 'tools' },
  };
}

async function withDigestSentDb(fn: (dbPath: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'chiya-publish-'));
  const dbPath = join(dir, 'jobs.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE job (id TEXT PRIMARY KEY, name TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING');
      CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO job (id, name, input, status) VALUES (?, ?, ?, ?)').run(
      'j1',
      'chiya-digest',
      JSON.stringify({ direction: 'AM', date: '2026-06-03' }),
      'COMPLETED',
    );
    db.prepare('INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)').run(
      'j1',
      'agent_activity',
      JSON.stringify({ type: 'agent_activity', agent: 'email-send', action: 'sent' }),
    );
  } finally {
    db.close();
  }
  try {
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it('once-daily email guard skips only email when a prior sent event exists', async () => {
    await withDigestSentDb(async (dbPath) => {
      const c = ctx({ digest: 'body' });
      const events = await drain(emailSend(makeEnv(), { onceDaily: true, dbPath }).run(c));
      expect(c.emailed).toEqual({ ok: true, output: 'skipped: email already sent for local date' });
      expect(events.at(-1)).toMatchObject({ type: 'agent_activity', agent: 'email-send', action: 'skipped' });
    });
  });
});

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { hasSuccessfulDigestEmail } from '../src/shared/digest-delivery.js';

function withDb(fn: (dbPath: string, db: Database.Database) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'chiya-digest-delivery-'));
  const dbPath = join(dir, 'jobs.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE job (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    fn(dbPath, db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('hasSuccessfulDigestEmail', () => {
  it('returns false for a fresh database without job/event tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chiya-digest-empty-'));
    const dbPath = join(dir, 'fresh.db');
    try {
      expect(hasSuccessfulDigestEmail(dbPath, '2026-06-02')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a sent email event for the same local date', () => {
    withDb((dbPath, db) => {
      db.prepare('INSERT INTO job (id, name, input, status) VALUES (?, ?, ?, ?)').run(
        'j1',
        'chiya-digest',
        JSON.stringify({ direction: 'AM', date: '2026-06-02' }),
        'COMPLETED',
      );
      db.prepare('INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)').run(
        'j1',
        'agent_activity',
        JSON.stringify({ type: 'agent_activity', agent: 'email-send', action: 'sent' }),
      );

      expect(hasSuccessfulDigestEmail(dbPath, '2026-06-02')).toBe(true);
      expect(hasSuccessfulDigestEmail(dbPath, '2026-06-03')).toBe(false);
    });
  });

  it('ignores failed email events', () => {
    withDb((dbPath, db) => {
      db.prepare('INSERT INTO job (id, name, input, status) VALUES (?, ?, ?, ?)').run(
        'j1',
        'chiya-digest',
        JSON.stringify({ direction: 'AM', date: '2026-06-02' }),
        'FAILED',
      );
      db.prepare('INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)').run(
        'j1',
        'agent_activity',
        JSON.stringify({ type: 'agent_activity', agent: 'email-send', action: 'failed' }),
      );

      expect(hasSuccessfulDigestEmail(dbPath, '2026-06-02')).toBe(false);
    });
  });
});

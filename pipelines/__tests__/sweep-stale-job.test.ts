import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { sweepStaleJobLock } from '../src/shared/sweep-stale-job.js';

// Minimal copy of thread-phase's job table schema; sweepStaleJobLock only
// reads `name`, `status`, `started_at` and writes `status`, `error`,
// `completed_at`, so anything else can stay shape-compatible.
const JOB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS job (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    input        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING',
    result       TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at   TEXT,
    completed_at TEXT
  );
`;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-sweep-'));
  dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.exec(JOB_SCHEMA);
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertJob(opts: {
  name: string;
  status: string;
  startedMinutesAgo: number | null;
}): string {
  const db = new Database(dbPath);
  const id = randomUUID();
  const startedAt =
    opts.startedMinutesAgo === null
      ? null
      : `datetime('now', '-${opts.startedMinutesAgo} minutes')`;
  db.prepare(
    `INSERT INTO job (id, name, input, status, started_at)
     VALUES (?, ?, '{}', ?, ${startedAt ?? 'NULL'})`,
  ).run(id, opts.name, opts.status);
  db.close();
  return id;
}

function getJobStatus(id: string): { status: string; error: string | null } {
  const db = new Database(dbPath);
  const row = db.prepare(`SELECT status, error FROM job WHERE id = ?`).get(id) as {
    status: string;
    error: string | null;
  };
  db.close();
  return row;
}

describe('sweepStaleJobLock', () => {
  it('flips a stuck RUNNING row older than threshold to FAILED with marker error', () => {
    const stuck = insertJob({ name: 'chiya-digest', status: 'RUNNING', startedMinutesAgo: 60 });
    const count = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
    expect(count).toBe(1);
    const after = getJobStatus(stuck);
    expect(after.status).toBe('FAILED');
    expect(after.error).toMatch(/swept-stale-lock/);
  });

  it('leaves fresh RUNNING rows alone', () => {
    const fresh = insertJob({ name: 'chiya-digest', status: 'RUNNING', startedMinutesAgo: 2 });
    const count = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
    expect(count).toBe(0);
    expect(getJobStatus(fresh).status).toBe('RUNNING');
  });

  it('does not touch rows for a different job name', () => {
    const other = insertJob({
      name: 'chiya-librarian',
      status: 'RUNNING',
      startedMinutesAgo: 60,
    });
    const count = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
    expect(count).toBe(0);
    expect(getJobStatus(other).status).toBe('RUNNING');
  });

  it('does not touch completed/failed rows of any age', () => {
    const done = insertJob({ name: 'chiya-digest', status: 'COMPLETED', startedMinutesAgo: 999 });
    const failed = insertJob({ name: 'chiya-digest', status: 'FAILED', startedMinutesAgo: 999 });
    const count = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
    expect(count).toBe(0);
    expect(getJobStatus(done).status).toBe('COMPLETED');
    expect(getJobStatus(failed).status).toBe('FAILED');
  });

  it('sweeps multiple stuck rows of the same name in one call', () => {
    insertJob({ name: 'chiya-digest', status: 'RUNNING', startedMinutesAgo: 60 });
    insertJob({ name: 'chiya-digest', status: 'RUNNING', startedMinutesAgo: 120 });
    const count = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
    expect(count).toBe(2);
  });

  it('threshold is exclusive: a row exactly at threshold-age survives, slightly older is swept', () => {
    // started_at = now - 25min: NOT swept (datetime('now', '-25 minutes') is NOT < datetime('now', '-25 minutes'))
    const atThreshold = insertJob({
      name: 'chiya-digest',
      status: 'RUNNING',
      startedMinutesAgo: 25,
    });
    // started_at = now - 26min: swept
    const justOver = insertJob({
      name: 'chiya-digest',
      status: 'RUNNING',
      startedMinutesAgo: 26,
    });
    const count = sweepStaleJobLock(dbPath, 'chiya-digest', 25);
    expect(count).toBe(1);
    expect(getJobStatus(atThreshold).status).toBe('RUNNING');
    expect(getJobStatus(justOver).status).toBe('FAILED');
  });
});

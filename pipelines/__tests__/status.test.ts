import { describe, expect, it } from 'vitest';

import { formatStatus, statusEnv, type StatusSnapshot } from '../src/status.js';

describe('statusEnv', () => {
  it('derives db path from vault dir unless overridden', () => {
    expect(statusEnv({ VAULT_DIR: '/tmp/vault' } as NodeJS.ProcessEnv)).toMatchObject({
      vaultDir: '/tmp/vault',
      dbPath: '/tmp/vault/.chiya-pipelines.db',
    });
    expect(statusEnv({ VAULT_DIR: '/tmp/vault', THREAD_PHASE_DB: '/tmp/db.sqlite' } as NodeJS.ProcessEnv).dbPath).toBe('/tmp/db.sqlite');
  });
});

describe('formatStatus', () => {
  it('formats article counts and recent jobs', () => {
    const snapshot: StatusSnapshot = {
      dbPath: '/tmp/db.sqlite',
      articles: { pending: 1, processing: 2, done: 3, skipped: 4, failed: 5 },
      jobs: [{
        id: 'job-1',
        name: 'chiya-librarian',
        status: 'COMPLETED',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        completedAt: new Date('2026-06-01T00:01:00Z'),
        eventCount: 7,
      }],
    };

    expect(formatStatus(snapshot)).toContain('articles: pending=1 processing=2 done=3 skipped=4 failed=5');
    expect(formatStatus(snapshot)).toContain('chiya-librarian COMPLETED events=7');
  });
});

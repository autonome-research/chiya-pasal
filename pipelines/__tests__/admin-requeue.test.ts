import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

import { ArticleStore } from '../src/shared/article-store.js';
import { formatReasonHistogram, parseRequeueArgs } from '../src/shared/users-admin.js';

describe('parseRequeueArgs', () => {
  it('parses the full flag set (dry-run by default)', () => {
    expect(parseRequeueArgs(['--user', 'velvet', '--status', 'failed'])).toEqual({
      handle: 'velvet',
      status: 'failed',
      likeReason: null,
      execute: false,
    });
  });

  it('accepts --execute, --key=value form, and skipped status', () => {
    expect(parseRequeueArgs(['--user=v', '--status=skipped', '--execute'])).toEqual({
      handle: 'v',
      status: 'skipped',
      likeReason: null,
      execute: true,
    });
  });

  it('wraps a plain --like value as a substring pattern', () => {
    expect(parseRequeueArgs(['--user', 'v', '--status', 'failed', '--like', 'timeout']).likeReason).toBe(
      '%timeout%',
    );
  });

  it('passes a --like value containing % through as a raw LIKE pattern', () => {
    expect(parseRequeueArgs(['--user', 'v', '--status', 'failed', '--like', 'upsert%']).likeReason).toBe(
      'upsert%',
    );
  });

  it('rejects missing --user, bad status, valueless flags, and unknown flags', () => {
    expect(() => parseRequeueArgs(['--status', 'failed'])).toThrow(/--user is required/);
    expect(() => parseRequeueArgs(['--user', 'v', '--status', 'done'])).toThrow(/--status must be/);
    expect(() => parseRequeueArgs(['--user', 'v'])).toThrow(/--status must be/);
    expect(() => parseRequeueArgs(['--user', 'v', '--status', 'failed', '--like'])).toThrow(
      /--like requires a value/,
    );
    expect(() => parseRequeueArgs(['--user', 'v', '--status', 'failed', '--nope'])).toThrow(
      /unknown requeue argument/,
    );
  });
});

describe('formatReasonHistogram', () => {
  it('right-aligns counts, labels null reasons, truncates long ones', () => {
    const lines = formatReasonHistogram([
      { reason: 'timeout', count: 12 },
      { reason: null, count: 3 },
      { reason: 'x'.repeat(150), count: 1 },
    ]);
    expect(lines[0]).toBe('    12  timeout');
    expect(lines[1]).toBe('     3  (no reason recorded)');
    expect(lines[2]).toBe(`     1  ${'x'.repeat(97)}...`);
  });
});

describe('admin requeue CLI', () => {
  it('dry-run shows the reason histogram without writing; --execute requeues', () => {
    const root = mkdtempSync(join(tmpdir(), 'chiya-admin-requeue-'));
    try {
      const vault = join(root, 'users', 'adminu', 'vault');
      mkdirSync(vault, { recursive: true });
      const usersFile = join(root, 'users.yaml');
      writeFileSync(
        usersFile,
        `users:
  - handle: adminu
    name: Admin User
    email_to: a@example.com
    vault_remote: git@github.com:x/vault-adminu.git
    interests: Testing requeue.
`,
      );

      const db = join(vault, '.chiya-pipelines.db');
      const store = new ArticleStore(db);
      const seed = (title: string, url: string): number =>
        store.upsertPending({
          title,
          url,
          source: 'RSS',
          field: 'AI/ML',
          snippet: null,
          collectedFrom: 'raw/inbox/x.md',
        }).id!;
      const a = seed('A', 'https://e.com/a');
      const b = seed('B', 'https://e.com/b');
      const c = seed('C', 'https://e.com/c');
      store.markFailed(a, 'timeout while summarizing');
      store.markFailed(b, 'other-problem');
      store.markDone(c, []);
      store.close();

      const env = { ...process.env, CHIYA_USERS_FILE: usersFile, CHIYA_DATA_ROOT: root };
      const admin = join(process.cwd(), 'src', 'admin.ts');
      const run = (...args: string[]): string => {
        const res = spawnSync('npx', ['tsx', admin, ...args], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env,
        });
        expect(res.status, res.stderr).toBe(0);
        return res.stdout;
      };

      const dry = run('requeue', '--user', 'adminu', '--status', 'failed');
      expect(dry).toContain("would requeue 2 'failed' article(s) for 'adminu'");
      expect(dry).toContain('timeout while summarizing');
      expect(dry).toContain('other-problem');

      // Dry-run wrote nothing.
      const check1 = new ArticleStore(db);
      expect(check1.countByStatus()).toMatchObject({ failed: 2, done: 1, pending: 0 });
      check1.close();

      const exec = run('requeue', '--user', 'adminu', '--status', 'failed', '--like', 'timeout', '--execute');
      expect(exec).toContain("requeued 1 'failed' article(s) to pending for 'adminu'");

      const check2 = new ArticleStore(db);
      try {
        expect(check2.countByStatus()).toMatchObject({ failed: 1, done: 1, pending: 1 });
        const rowA = check2.getById(a)!;
        expect(rowA.status).toBe('pending');
        expect(rowA.statusReason).toBeNull();
        expect(check2.getById(b)!.status).toBe('failed');
      } finally {
        check2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

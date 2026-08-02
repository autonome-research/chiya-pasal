import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

import { ArticleStore } from '../src/shared/article-store.js';

const script = join(process.cwd(), 'scripts', 'repair-error-summaries.ts');

const ERROR_BLOB = `{"_error":true,"message":"404 model 'gemma4:e4b' not found"}`;

function sourcePage(url: string, title: string, summary: string): string {
  return `---
type: source
status: ingested
url: ${url}
title: "${title}"
topics: [uncategorized]
---

# ${title}

## Summary

${summary}

## Topics

- [[wiki/topics/uncategorized]]
`;
}

interface Fixture {
  root: string;
  vault: string;
  db: string;
  out: string;
  usersFile: string;
  env: NodeJS.ProcessEnv;
  recoverableId: number;
  unrecoverableId: number;
  healthyId: number;
}

/**
 * Fixture vault for user 'repairu':
 *   arxiv-2605-11111.md  poisoned, row done with prose snippet → recoverable
 *   url-deadbeef.md      poisoned, row done with NULL snippet  → unrecoverable
 *   url-orphan.md        poisoned, no row                      → orphan
 *   arxiv-2605-22222.md  healthy page + row                    → untouched
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'chiya-repair-'));
  const vault = join(root, 'users', 'repairu', 'vault');
  const sources = join(vault, 'wiki', 'sources');
  mkdirSync(sources, { recursive: true });

  const usersFile = join(root, 'users.yaml');
  writeFileSync(
    usersFile,
    `users:
  - handle: repairu
    name: Repair User
    email_to: r@example.com
    vault_remote: git@github.com:x/vault-repairu.git
    interests: Testing repair flows.
`,
  );

  writeFileSync(
    join(sources, 'arxiv-2605-11111.md'),
    sourcePage('https://arxiv.org/abs/2605.11111', 'Recoverable Paper', ERROR_BLOB),
  );
  writeFileSync(
    join(sources, 'url-deadbeef.md'),
    sourcePage('https://example.com/lost-story', 'Lost Story', ERROR_BLOB),
  );
  writeFileSync(
    join(sources, 'url-orphan.md'),
    sourcePage('https://example.com/no-row', 'Orphan Page', ERROR_BLOB),
  );
  writeFileSync(
    join(sources, 'arxiv-2605-22222.md'),
    sourcePage('https://arxiv.org/abs/2605.22222', 'Healthy Paper', 'A perfectly normal summary paragraph.'),
  );

  const db = join(vault, '.chiya-pipelines.db');
  const store = new ArticleStore(db);
  const recoverableId = store.upsertPending({
    title: 'Recoverable Paper',
    url: 'https://arxiv.org/abs/2605.11111',
    source: 'arXiv',
    field: 'AI/ML',
    snippet:
      'A usable abstract with plenty of prose: this paper studies repair flows in ' +
      'multi-tenant research pipelines and reports strong results.',
    collectedFrom: 'raw/inbox/2026-05-20-articles.md',
  }).id!;
  store.markDone(recoverableId, ['wiki/sources/arxiv-2605-11111.md']);

  const unrecoverableId = store.upsertPending({
    title: 'Lost Story',
    url: 'https://example.com/lost-story',
    source: 'RSS',
    field: 'TechCrunch',
    snippet: null,
    collectedFrom: 'raw/inbox/2026-05-21-articles.md',
  }).id!;
  store.markDone(unrecoverableId, ['wiki/sources/url-deadbeef.md']);

  const healthyId = store.upsertPending({
    title: 'Healthy Paper',
    url: 'https://arxiv.org/abs/2605.22222',
    source: 'arXiv',
    field: 'AI/ML',
    snippet: 'Another usable abstract.',
    collectedFrom: 'raw/inbox/2026-05-22-articles.md',
  }).id!;
  store.markDone(healthyId, ['wiki/sources/arxiv-2605-22222.md']);
  store.close();

  return {
    root,
    vault,
    db,
    out: join(root, 'repair-reingest.md'),
    usersFile,
    env: { ...process.env, CHIYA_USERS_FILE: usersFile, CHIYA_DATA_ROOT: root },
    recoverableId,
    unrecoverableId,
    healthyId,
  };
}

function run(f: Fixture, ...extra: string[]): { json: Record<string, unknown>; stdout: string } {
  const res = spawnSync(
    'npx',
    ['tsx', script, '--user', 'repairu', '--out', f.out, ...extra],
    { cwd: process.cwd(), encoding: 'utf8', env: f.env },
  );
  expect(res.status, res.stderr).toBe(0);
  const lines = res.stdout.trim().split('\n');
  return { json: JSON.parse(lines[lines.length - 1]!), stdout: res.stdout };
}

function statuses(f: Fixture): Map<number, { status: string; pagePaths: string[] }> {
  const store = new ArticleStore(f.db);
  try {
    const out = new Map<number, { status: string; pagePaths: string[] }>();
    for (const id of [f.recoverableId, f.unrecoverableId, f.healthyId]) {
      const row = store.getById(id);
      if (row) out.set(id, { status: row.status, pagePaths: row.pagePaths });
    }
    return out;
  } finally {
    store.close();
  }
}

describe('repair-error-summaries script', () => {
  it('dry-run partitions correctly and touches nothing', () => {
    const f = fixture();
    try {
      const { json, stdout } = run(f);
      expect(json).toMatchObject({
        mode: 'dry-run',
        scanned: 4,
        poisoned: 3,
        recoverable: 1,
        unrecoverable: 1,
        orphans: 1,
        requeued: 0,
        deletedRows: 0,
        deletedPages: 0,
        reingestLines: 0,
      });
      expect(stdout).toContain('wiki/sources/url-orphan.md');

      // Nothing touched: pages intact, rows still done, no re-ingest file.
      for (const p of ['arxiv-2605-11111.md', 'url-deadbeef.md', 'url-orphan.md', 'arxiv-2605-22222.md']) {
        expect(existsSync(join(f.vault, 'wiki', 'sources', p))).toBe(true);
      }
      const s = statuses(f);
      expect(s.get(f.recoverableId)!.status).toBe('done');
      expect(s.get(f.unrecoverableId)!.status).toBe('done');
      expect(existsSync(f.out)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('execute repairs each cohort and is idempotent on re-run', () => {
    const f = fixture();
    try {
      const first = run(f, '--execute');
      expect(first.json).toMatchObject({
        mode: 'EXECUTE',
        poisoned: 3,
        recoverable: 1,
        unrecoverable: 1,
        orphans: 1,
        requeued: 1,
        deletedRows: 1,
        deletedPages: 2,
        reingestLines: 1,
      });

      // Recoverable: row back to pending with cleared page_paths, file gone.
      const s = statuses(f);
      expect(s.get(f.recoverableId)).toEqual({ status: 'pending', pagePaths: [] });
      expect(existsSync(join(f.vault, 'wiki', 'sources', 'arxiv-2605-11111.md'))).toBe(false);

      // Unrecoverable: row deleted, file gone, re-ingest line emitted.
      expect(s.has(f.unrecoverableId)).toBe(false);
      expect(existsSync(join(f.vault, 'wiki', 'sources', 'url-deadbeef.md'))).toBe(false);
      const reingest = readFileSync(f.out, 'utf-8');
      expect(reingest).toContain('#### TechCrunch');
      expect(reingest).toContain('- [Lost Story](https://example.com/lost-story) *(RSS)*');

      // Orphan reported but never touched; healthy page untouched.
      expect(existsSync(join(f.vault, 'wiki', 'sources', 'url-orphan.md'))).toBe(true);
      expect(existsSync(join(f.vault, 'wiki', 'sources', 'arxiv-2605-22222.md'))).toBe(true);
      expect(s.get(f.healthyId)!.status).toBe('done');

      // Idempotent re-run: only the orphan remains, nothing changes.
      const second = run(f, '--execute');
      expect(second.json).toMatchObject({
        poisoned: 1,
        recoverable: 0,
        unrecoverable: 0,
        orphans: 1,
        requeued: 0,
        deletedRows: 0,
        deletedPages: 0,
        reingestLines: 0,
      });
      expect(readFileSync(f.out, 'utf-8')).toBe(reingest);
      expect(statuses(f).get(f.recoverableId)!.status).toBe('pending');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'backfill-archive-articles.ts');

function fixtureVault(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chiya-backfill-'));
  const archive = join(dir, 'raw', 'inbox', 'archive');
  mkdirSync(archive, { recursive: true });
  writeFileSync(
    join(archive, '2026-05-31-articles.md'),
    `---
type: article
---

# Raw Articles — 2026-05-31

#### AI
- [First Paper](https://example.org/first) *(arXiv)* — useful abstract
- [Second Paper](https://example.org/second) *(OpenAlex)* — another abstract
- [Zenodo Dataset](17548056) *(Zenodo)* — dataset abstract
`,
  );
  return { dir, db: join(dir, '.chiya-pipelines.db') };
}

describe('backfill-archive-articles script', () => {
  it('restores archived raw articles using the archive date and skips duplicates', () => {
    const { dir, db } = fixtureVault();
    try {
      const first = spawnSync('npx', ['tsx', script, `--vault=${dir}`, `--db=${db}`, '--status=pending'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ files: 1, parsed: 3, inserted: 3 });

      const second = spawnSync('npx', ['tsx', script, `--vault=${dir}`, `--db=${db}`, '--status=pending'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ files: 1, parsed: 3, inserted: 0 });

      const sql = new Database(db);
      try {
        const rows = sql.prepare('SELECT title, status, collected_at FROM article ORDER BY title').all() as Array<{
          title: string;
          status: string;
          collected_at: string;
        }>;
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
        expect(rows.every((r) => r.collected_at.startsWith('2026-05-31'))).toBe(true);
        expect((sql.prepare('SELECT url FROM article WHERE title = ?').get('Zenodo Dataset') as { url: string }).url).toBe(
          'https://zenodo.org/records/17548056',
        );
      } finally {
        sql.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can restore rows as done for dedup memory without queueing graph work', () => {
    const { dir, db } = fixtureVault();
    try {
      const result = spawnSync('npx', ['tsx', script, `--vault=${dir}`, `--db=${db}`, '--status=done'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ inserted: 3, markedDone: 3 });

      const sql = new Database(db);
      try {
        const statuses = sql.prepare('SELECT DISTINCT status FROM article').all() as Array<{ status: string }>;
        expect(statuses.map((r) => r.status)).toEqual(['done']);
      } finally {
        sql.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

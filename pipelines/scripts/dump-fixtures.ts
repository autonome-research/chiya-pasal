import { writeFileSync, mkdirSync } from 'fs';
import { dirname, basename } from 'path';
import { glob } from 'glob';
import Database from 'better-sqlite3';
import { ArticleStore } from '../src/shared/article-store.js';
import { loadChiyaEnv } from '../src/shared/env.js';

async function main() {
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB || env.vaultDir + '/.chiya-pipelines.db';
  const store = new ArticleStore(dbPath);

  const topicPaths = await glob('wiki/topics/**/*.md', { cwd: env.vaultDir, nodir: true });
  const topics = topicPaths
    .filter((p) => !p.includes('/archive/'))
    .map((p) => ({ slug: basename(p, '.md'), members: store.findByPagePath(p).length }));
  topics.sort((a, b) => b.members - a.members);

  const db = new Database(dbPath, { readonly: true });
  const fixtures = db.prepare(`
    SELECT id, title, url, source, field, snippet
    FROM article
    WHERE status='done' AND snippet IS NOT NULL AND length(snippet) > 100
    ORDER BY processed_at DESC LIMIT 12
  `).all();

  const target = '/home/velvet/chiya-library/pipelines/scripts/eval-fixtures.json';
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ topics, articles: fixtures }, null, 2));
  console.log('wrote', target, 'topics:', topics.length, 'articles:', fixtures.length);

  db.close();
  store.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

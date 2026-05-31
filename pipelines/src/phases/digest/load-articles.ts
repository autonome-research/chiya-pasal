/** Load digest article candidates from ArticleStore. */

import { requireCtx, type Phase } from 'thread-phase';

import { type Article } from '../../shared/article.js';
import type { ArticleStore, ArticleRow } from '../../shared/article-store.js';
import type { DigestCtx } from '../../shared/digest-types.js';

/**
 * Source of truth for "today's articles" is now the ArticleStore — surfaces
 * every collection from the day, deduped by url_hash/title_hash.
 * Falls back to the most recent N days if today is empty.
 */
export const loadArticles = (store: ArticleStore): Phase<DigestCtx> => ({
  name: 'load-articles',
  async *run(ctx) {
    const todayRows = store.listByLocalDate(ctx.date);

    let rows: ArticleRow[] = todayRows;
    let source = `db: ${ctx.date}`;

    if (rows.length === 0) {
      const fallback = recentArticles(store, 3);
      rows = fallback.rows;
      source = fallback.source;
    }

    ctx.articlesPath = source;
    ctx.articles = rows.map(rowToArticle);

    yield {
      type: 'phase',
      phase: 'load-articles',
      detail: `${rows.length} articles (${source})`,
      counts: { articles: rows.length },
    };
  },
});

function rowToArticle(r: ArticleRow): Article {
  return {
    title: r.title,
    url: r.url ?? '',
    source: r.source,
    field: r.field ?? 'Uncategorized',
    snippet: r.snippet,
  };
}

function recentArticles(store: ArticleStore, lookbackDays: number): {
  rows: ArticleRow[];
  source: string;
} {
  for (let d = 1; d <= lookbackDays; d++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - d);
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const rows = store.listByLocalDate(date);
    if (rows.length > 0) return { rows, source: `db: fallback ${date} (today empty)` };
  }
  return { rows: [], source: 'db: empty' };
}

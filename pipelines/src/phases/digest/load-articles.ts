/** Load digest article candidates from ArticleStore. */

import { type Phase } from 'thread-phase';

import { type Article } from '../../shared/article.js';
import type { ArticleStore, ArticleRow } from '../../shared/article-store.js';
import type { DigestCtx } from '../../shared/digest-types.js';

/**
 * Row ids this run loaded, handed from `load-articles` to `email-send` so the
 * publish side can stamp `digested_at` on exactly what went out.
 *
 * A plain mutable box rather than a `DigestCtx` field: the ids are internal
 * bookkeeping between two phases, not part of the digest's rendered context,
 * and keeping them out of the ctx keeps them out of the persisted job summary.
 */
export interface DigestSelection {
  /** Article ids in load order; empty until `load-articles` has run. */
  ids: number[];
}

export function createDigestSelection(): DigestSelection {
  return { ids: [] };
}

/**
 * Source of truth for "today's articles" is now the ArticleStore — surfaces
 * every collection from the day, deduped by url_hash/title_hash, minus
 * anything an earlier digest already consumed (`digested_at IS NULL`).
 * Falls back to the most recent N days if today is empty.
 *
 * The undigested filter is what separates AM from PM: the PM run sees only
 * what arrived after the AM mail went out. It is scoped INSIDE the existing
 * date window, so the window semantics (local calendar day, 3-day fallback)
 * are unchanged.
 */
export const loadArticles = (
  store: ArticleStore,
  selection?: DigestSelection,
): Phase<DigestCtx> => ({
  name: 'load-articles',
  async *run(ctx) {
    const todayRows = store.listUndigestedByLocalDate(ctx.date);

    let rows: ArticleRow[] = todayRows;
    let source = `db: ${ctx.date}`;

    if (rows.length === 0) {
      const fallback = recentArticles(store, 3);
      rows = fallback.rows;
      source = fallback.source;
    }

    ctx.articlesPath = source;
    ctx.articles = rows.map(rowToArticle);
    if (selection) selection.ids = rows.map((r) => r.id);

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
    const rows = store.listUndigestedByLocalDate(date);
    if (rows.length > 0) return { rows, source: `db: fallback ${date} (today empty)` };
  }
  return { rows: [], source: 'db: empty' };
}

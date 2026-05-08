/**
 * Agent-callable wrappers around ArticleStore reads. The v3 librarian's
 * scouts (especially cite-tracker and source-scout) need to ask
 *   "is this arxiv ID already in the library?"
 *   "is this DOI?"
 *   "find sibling articles by title keywords"
 * — without grepping the filesystem. These tools surface those queries to
 * the agent.
 *
 * The article rows are returned in a compact text format the LLM can read
 * directly; the source-page filename (computed from the row's URL) is
 * included so the agent can vault_read the source page if it exists.
 */

import type { ToolRegistry } from 'thread-phase';

import type { ArticleRow, ArticleStore } from '../shared/article-store.js';
import { stableIdForUrl, stableIdToFilename } from '../phases/page-templates.js';

/** Format one row as a single line: status + filename + title + collected date. */
function formatRow(row: ArticleRow): string {
  const sid = row.url ? stableIdForUrl(row.url) : null;
  const filename = sid ? stableIdToFilename(sid) : '(no-stable-id)';
  const date = row.collectedAt.toISOString().slice(0, 10);
  return `${filename} | ${date} | ${row.title.slice(0, 120)}`;
}

export function registerArticleLookupTools(
  registry: ToolRegistry,
  store: ArticleStore,
): void {
  registry.register(
    {
      name: 'article_lookup_by_arxiv',
      description:
        'Look up an article in the library by arXiv ID (e.g. "2605.03823" or "2605.03823v2"). ' +
        'Returns one line "filename | YYYY-MM-DD | title" if found, else "(not in library)". ' +
        'Use the returned filename with vault_read("wiki/sources/{filename}.md") to inspect.',
      inputSchema: {
        type: 'object',
        properties: { arxiv_id: { type: 'string' } },
        required: ['arxiv_id'],
      },
    },
    async ({ arxiv_id }) => {
      const row = store.findByArxivId(String(arxiv_id));
      return row ? formatRow(row) : '(not in library)';
    },
  );

  registry.register(
    {
      name: 'article_lookup_by_doi',
      description:
        'Look up an article in the library by DOI (e.g. "10.1038/s41586-024-12345-6", with or without the doi.org prefix). ' +
        'Returns one line "filename | YYYY-MM-DD | title" if found, else "(not in library)".',
      inputSchema: {
        type: 'object',
        properties: { doi: { type: 'string' } },
        required: ['doi'],
      },
    },
    async ({ doi }) => {
      const row = store.findByDoi(String(doi));
      return row ? formatRow(row) : '(not in library)';
    },
  );

  registry.register(
    {
      name: 'article_search_by_title',
      description:
        'Search the library for articles whose title matches every keyword (AND, case-insensitive). ' +
        'Returns up to 10 matches as one "filename | YYYY-MM-DD | title" per line, newest first. ' +
        'Use to surface sibling source pages potentially related to the article being indexed.',
      inputSchema: {
        type: 'object',
        properties: {
          keywords: {
            type: 'string',
            description: 'Whitespace-separated keywords. Each must appear in the title (substring).',
          },
          limit: { type: 'number', description: 'Max rows to return. Default 10.' },
        },
        required: ['keywords'],
      },
    },
    async ({ keywords, limit }) => {
      const cap = typeof limit === 'number' && limit > 0 && limit <= 50 ? limit : 10;
      const rows = store.searchByTitle(String(keywords), cap);
      if (rows.length === 0) return '(no matches)';
      return rows.map(formatRow).join('\n');
    },
  );
}

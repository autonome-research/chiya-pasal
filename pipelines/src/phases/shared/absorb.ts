/**
 * Absorb phase — move matcha's collected articles files into the shared
 * article cache. The multi-tenant replacement for the per-user intake
 * pipeline: one shared inbox, one shared dedup, one cache row per article.
 *
 * Articles without a URL are skipped with a count — no URL means no stable
 * ID, no enrichment, no source page. (The per-user librarian applied the
 * same rule.) Query labels start as the article's collection `field:` tag;
 * duplicates merge labels on the shared row.
 */

import { rename, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { requireCtx, type Phase } from 'thread-phase';

import type { SharedPipelineCtx } from '../../shared/shared-pipeline-types.js';
import { parseArticles } from '../../shared/article.js';
import type { SharedArticleStore } from '../../shared/shared-article-store.js';
import type { VaultFs } from '../../tools/vault.js';
import { stableIdForUrl, stableIdToFilename } from '../page-templates.js';

/**
 * inboxFs is a VaultFs rooted at the shared inbox directory — VaultFs is
 * (despite the name) a rooted filesystem with path-escape guards, which is
 * exactly what any pipeline-owned directory wants.
 */
export const scanSharedInbox = (inboxFs: VaultFs): Phase<SharedPipelineCtx> => ({
  name: 'scan-shared-inbox',
  async *run(ctx) {
    const files = await inboxFs.list('*-articles.md');
    ctx.inboxFiles = files;
    yield {
      type: 'phase',
      phase: 'scan-shared-inbox',
      detail: `${files.length} articles file(s) in shared inbox`,
      counts: { files: files.length },
    };
  },
});

export const absorbInbox = (
  inboxFs: VaultFs,
  store: SharedArticleStore,
): Phase<SharedPipelineCtx> => ({
  name: 'absorb-inbox',
  async *run(ctx) {
    const files = requireCtx(ctx, 'inboxFiles', 'absorb-inbox');

    let parsed = 0;
    let inserted = 0;
    let duplicates = 0;
    let skippedNoUrl = 0;

    for (const file of files) {
      const text = await inboxFs.read(file);
      const articles = parseArticles(text);
      parsed += articles.length;

      for (const a of articles) {
        const url = a.url?.trim();
        const sid = url ? stableIdForUrl(url) : null;
        if (!url || !sid) {
          skippedNoUrl++;
          continue;
        }
        const result = store.upsertCollected({
          stableId: stableIdToFilename(sid),
          url,
          title: a.title,
          source: a.source,
          field: a.field,
          queryLabels: a.field ? [a.field] : [],
          abstract: a.snippet,
        });
        if (result === 'inserted') inserted++;
        else duplicates++;
      }

      // Archive after successful parse+store so a crash mid-file re-parses
      // (idempotent) rather than losing the file.
      const src = join(inboxFs.rootDir, file);
      const dst = join(inboxFs.rootDir, 'archive', file);
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);

      yield {
        type: 'agent_activity',
        agent: 'absorb-inbox',
        action: 'absorbed',
        detail: `${file}: ${articles.length} parsed`,
      };
    }

    ctx.absorbCounts = { files: files.length, parsed, inserted, duplicates, skippedNoUrl };
    yield {
      type: 'phase',
      phase: 'absorb-inbox',
      detail: `${files.length} files / ${parsed} parsed / ${inserted} new / ${duplicates} dup / ${skippedNoUrl} no-url`,
      counts: ctx.absorbCounts,
    };
  },
});

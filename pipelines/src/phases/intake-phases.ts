/**
 * Intake pipeline — moves matcha's articles files into the ArticleStore.
 *
 * Walks `vault/raw/inbox/*-articles.md`, parses each, upserts every row,
 * then archives the source file to `vault/raw/inbox/archive/`. After this
 * runs, the librarian sees new articles via `ArticleStore.listPending`.
 *
 * Replaces `split_queue.py` for the forward flow. The 514 already-split
 * queue files are handled separately by migrate-queue.ts (one-shot).
 */

import { rename, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import {
  requireCtx,
  type BasePipelineContext,
  type Phase,
} from 'thread-phase';

import { parseArticles } from '../shared/article.js';
import type { ArticleStore } from '../shared/article-store.js';
import type { VaultFs } from '../tools/vault.js';

export interface IntakeCtx extends BasePipelineContext {
  vaultDir: string;
  /** vault-relative paths to *-articles.md files awaiting intake */
  inboxFiles?: string[];
  /** insert/dup tallies keyed by source file */
  fileResults?: Array<{
    file: string;
    inserted: number;
    duplicateUrl: number;
    duplicateTitle: number;
    parsed: number;
  }>;
}

export const scanInbox = (vault: VaultFs): Phase<IntakeCtx> => ({
  name: 'scan-inbox',
  async *run(ctx) {
    const files = await vault.list('raw/inbox/*-articles.md');
    ctx.inboxFiles = files;
    yield {
      type: 'phase',
      phase: 'scan-inbox',
      detail: `${files.length} articles file(s) waiting in inbox`,
      counts: { files: files.length },
    };
  },
});

export const parseAndStore = (vault: VaultFs, store: ArticleStore): Phase<IntakeCtx> => ({
  name: 'parse-and-store',
  async *run(ctx) {
    const files = requireCtx(ctx, 'inboxFiles', 'parse-and-store');
    const fileResults: NonNullable<IntakeCtx['fileResults']> = [];

    if (files.length === 0) {
      ctx.fileResults = [];
      yield { type: 'phase', phase: 'parse-and-store', detail: 'nothing to do' };
      return;
    }

    for (const file of files) {
      const text = await vault.read(file);
      const articles = parseArticles(text);
      let inserted = 0;
      let duplicateUrl = 0;
      let duplicateTitle = 0;
      for (const a of articles) {
        const r = store.upsertPending({
          title: a.title,
          url: a.url || null, // parser uses '' for empty URL; treat as null
          source: a.source,
          field: a.field,
          snippet: a.snippet,
          collectedFrom: file,
        });
        if (r.result === 'inserted') inserted++;
        else if (r.result === 'duplicate-url') duplicateUrl++;
        else duplicateTitle++;
      }
      fileResults.push({ file, parsed: articles.length, inserted, duplicateUrl, duplicateTitle });
      yield {
        type: 'agent_activity',
        agent: 'parse-and-store',
        action: 'imported',
        detail: `${file}: ${inserted} new, ${duplicateUrl + duplicateTitle} dup, ${articles.length} parsed`,
      };
    }

    ctx.fileResults = fileResults;
    const totals = fileResults.reduce(
      (acc, r) => ({
        files: acc.files + 1,
        parsed: acc.parsed + r.parsed,
        inserted: acc.inserted + r.inserted,
        dup: acc.dup + r.duplicateUrl + r.duplicateTitle,
      }),
      { files: 0, parsed: 0, inserted: 0, dup: 0 },
    );
    yield {
      type: 'phase',
      phase: 'parse-and-store',
      detail: `${totals.files} files / ${totals.parsed} parsed / ${totals.inserted} new / ${totals.dup} dup`,
      counts: totals,
    };
  },
});

export const archiveInboxFiles = (vault: VaultFs): Phase<IntakeCtx> => ({
  name: 'archive-inbox',
  async *run(ctx) {
    const fileResults = requireCtx(ctx, 'fileResults', 'archive-inbox');
    if (fileResults.length === 0) return;

    const archiveRoot = join(vault.rootDir, 'raw', 'inbox', 'archive');
    await mkdir(archiveRoot, { recursive: true });

    for (const { file } of fileResults) {
      const src = join(vault.rootDir, file);
      const dst = join(archiveRoot, file.replace(/^raw\/inbox\//, ''));
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);
    }

    yield {
      type: 'agent_activity',
      agent: 'archive-inbox',
      action: 'archived',
      detail: `${fileResults.length} file(s) → raw/inbox/archive/`,
    };
  },
});

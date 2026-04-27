/**
 * ArticleStore — sqlite-backed table of every article ever ingested.
 *
 * Replaces the file-based queue model:
 *   - `vault/raw/inbox/queue/*.md`  → `article` table rows
 *   - dedup via url_hash unique-when-present + title_hash
 *   - status FSM: pending → processing → (done | skipped | failed)
 *   - the librarian reads `WHERE status='pending' LIMIT N` instead of globbing
 *
 * Lives in the same DB file as thread-phase's JobStore (one connection per
 * class; sqlite WAL handles concurrency).
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { createHash } from 'crypto';
import { normalizeUrl } from './url-normalize.js';

export type ArticleStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'failed';

export interface ArticleRow {
  id: number;
  url: string | null;
  urlHash: string | null;
  title: string;
  titleHash: string;
  source: string | null;
  field: string | null;
  snippet: string | null;
  collectedAt: Date;
  collectedFrom: string;
  status: ArticleStatus;
  statusReason: string | null;
  processedAt: Date | null;
  pagePaths: string[];
}

export interface ArticleInput {
  title: string;
  url: string | null;
  source: string | null;
  field: string | null;
  snippet: string | null;
  /** Path of the source file the row came from (for audit + re-import). */
  collectedFrom: string;
  /** Override collected_at; defaults to now(). */
  collectedAt?: Date;
}

export type UpsertResult = 'inserted' | 'duplicate-url' | 'duplicate-title';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS article (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT,
  url_hash        TEXT,
  title           TEXT NOT NULL,
  title_hash      TEXT NOT NULL,
  source          TEXT,
  field           TEXT,
  snippet         TEXT,
  collected_at    TEXT NOT NULL DEFAULT (datetime('now')),
  collected_from  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  status_reason   TEXT,
  processed_at    TEXT,
  page_paths      TEXT NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_url_hash
  ON article(url_hash) WHERE url_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_article_title_hash ON article(title_hash);
CREATE INDEX IF NOT EXISTS idx_article_status_collected
  ON article(status, collected_at);
`;

interface RawRow {
  id: number;
  url: string | null;
  url_hash: string | null;
  title: string;
  title_hash: string;
  source: string | null;
  field: string | null;
  snippet: string | null;
  collected_at: string;
  collected_from: string;
  status: ArticleStatus;
  status_reason: string | null;
  processed_at: string | null;
  page_paths: string;
}

function parseDate(s: string | null): Date | null {
  return s ? new Date(s + 'Z') : null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class ArticleStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /**
   * Insert a new article in pending state. Dedup behavior:
   *   - if url_hash exists in the table → returns 'duplicate-url' (NO insert)
   *   - else if title_hash exists → returns 'duplicate-title' (NO insert)
   *   - else inserts and returns 'inserted'
   *
   * Title-only dedup is conservative — different sources can legitimately
   * publish the same paper, but for cheap firstpass dedup it's the right call.
   */
  upsertPending(input: ArticleInput): { result: UpsertResult; id: number | null } {
    const normalizedUrl = normalizeUrl(input.url);
    const urlHash = normalizedUrl ? sha256(normalizedUrl) : null;
    const titleHash = sha256(normalizeTitle(input.title));

    if (urlHash) {
      const existing = this.db
        .prepare(`SELECT id FROM article WHERE url_hash = ?`)
        .get(urlHash) as { id: number } | undefined;
      if (existing) return { result: 'duplicate-url', id: existing.id };
    }

    const titleDup = this.db
      .prepare(`SELECT id FROM article WHERE title_hash = ? LIMIT 1`)
      .get(titleHash) as { id: number } | undefined;
    if (titleDup) return { result: 'duplicate-title', id: titleDup.id };

    const stmt = this.db.prepare(
      `INSERT INTO article (url, url_hash, title, title_hash, source, field, snippet,
                            collected_at, collected_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
    );
    const result = stmt.run(
      normalizedUrl,
      urlHash,
      input.title,
      titleHash,
      input.source,
      input.field,
      input.snippet,
      input.collectedAt ? input.collectedAt.toISOString().slice(0, 19).replace('T', ' ') : null,
      input.collectedFrom,
    );
    return { result: 'inserted', id: Number(result.lastInsertRowid) };
  }

  /**
   * Pull up to `limit` pending articles, oldest-first. Does NOT mark them
   * processing — caller does that explicitly so the FSM transition is
   * observable (for crash recovery + audit).
   */
  listPending(limit: number): ArticleRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM article WHERE status = 'pending'
         ORDER BY collected_at ASC, id ASC LIMIT ?`,
      )
      .all(limit) as RawRow[];
    return rows.map(toArticleRow);
  }

  /** Articles collected on a given UTC date string (YYYY-MM-DD). For digest. */
  listByDate(dateUtc: string): ArticleRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM article WHERE collected_at LIKE ?
         ORDER BY id ASC`,
      )
      .all(`${dateUtc}%`) as RawRow[];
    return rows.map(toArticleRow);
  }

  getById(id: number): ArticleRow | null {
    const row = this.db.prepare(`SELECT * FROM article WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? toArticleRow(row) : null;
  }

  // ---- status transitions ---------------------------------------------------

  markProcessing(id: number): void {
    this.db
      .prepare(
        `UPDATE article SET status='processing', processed_at=datetime('now') WHERE id=?`,
      )
      .run(id);
  }

  markDone(id: number, pagePaths: string[]): void {
    this.db
      .prepare(
        `UPDATE article SET status='done', page_paths=?, processed_at=datetime('now')
         WHERE id=?`,
      )
      .run(JSON.stringify(pagePaths), id);
  }

  markSkipped(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE article SET status='skipped', status_reason=?, processed_at=datetime('now')
         WHERE id=?`,
      )
      .run(reason, id);
  }

  markFailed(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE article SET status='failed', status_reason=?, processed_at=datetime('now')
         WHERE id=?`,
      )
      .run(reason, id);
  }

  /**
   * Reset 'processing' rows older than `maxAgeMinutes' back to 'pending'.
   * Crash recovery: if the librarian died mid-article, the next run picks
   * those up.
   */
  reapStaleProcessing(maxAgeMinutes: number): number {
    const result = this.db
      .prepare(
        `UPDATE article SET status='pending', processed_at=NULL
         WHERE status='processing'
           AND processed_at < datetime('now', ?)`,
      )
      .run(`-${maxAgeMinutes} minutes`);
    return result.changes;
  }

  // ---- counts / observability ----------------------------------------------

  countByStatus(): Record<ArticleStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM article GROUP BY status`)
      .all() as Array<{ status: ArticleStatus; n: number }>;
    const out: Record<ArticleStatus, number> = {
      pending: 0,
      processing: 0,
      done: 0,
      skipped: 0,
      failed: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function toArticleRow(r: RawRow): ArticleRow {
  return {
    id: r.id,
    url: r.url,
    urlHash: r.url_hash,
    title: r.title,
    titleHash: r.title_hash,
    source: r.source,
    field: r.field,
    snippet: r.snippet,
    collectedAt: parseDate(r.collected_at)!,
    collectedFrom: r.collected_from,
    status: r.status,
    statusReason: r.status_reason,
    processedAt: parseDate(r.processed_at),
    pagePaths: JSON.parse(r.page_paths),
  };
}

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
  /** Refs pre-extracted by the shared layer; null on legacy/single-tenant rows. */
  refsArxiv: string[] | null;
  refsDoi: string[] | null;
  /** Provenance pointer into the shared cache; null when not routed. */
  sharedStableId: string | null;
  /** Cosine similarity at routing time; null when not routed. */
  routedSimilarity: number | null;
  /** Quality scores from the shared summarize phase, carried through the
   *  route copy so the librarian and the wiki can see them. Null on legacy
   *  rows and on anything that never passed through the shared pipeline. */
  qualityRigor: number | null;
  qualityEvidence: number | null;
  /** When a digest consumed this row (classified it into a bucket, skip
   *  included) AND the digest email actually went out. Null = still eligible
   *  for the next digest. Independent of the librarian's `status` FSM: the
   *  two pipelines consume the same rows for different purposes. */
  digestedAt: Date | null;
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

/** Selector for the terminal-status requeue path (admin CLI + repair script). */
export interface RequeueFilter {
  status: Extract<ArticleStatus, 'failed' | 'skipped'>;
  /** Raw SQL LIKE pattern matched against status_reason; omit for all reasons. */
  likeReason?: string;
}

/**
 * Input for rows the multi-tenant routing layer copies into a user's store.
 * The rich summary rides in `summary` (stored in the snippet column — it IS
 * the body the per-user librarian works from); refs are pre-extracted by the
 * shared enrich phase so the per-user pipeline never re-fetches full text.
 */
export interface RoutedArticleInput {
  title: string;
  url: string;
  source: string | null;
  field: string | null;
  /** Rich summary from the shared summarize phase. */
  summary: string;
  refsArxiv: string[];
  refsDoi: string[];
  sharedStableId: string;
  /** Cosine at routing time; null in broadcast mode (no embeddings). */
  routedSimilarity: number | null;
  /** Shared-layer quality assessment; null when the shared row was never
   *  scored (pre-quality-gate rows). Optional so callers predating the
   *  columns still typecheck. */
  qualityRigor?: number | null;
  qualityEvidence?: number | null;
  collectedAt?: Date;
}

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

/**
 * Columns added after the original schema shipped. Applied idempotently on
 * every open: SQLite's ALTER TABLE ADD COLUMN is metadata-only (no table
 * rewrite), and checking PRAGMA table_info first keeps re-opens silent.
 * Additive-nullable only — never widen this mechanism into destructive
 * migrations.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'refs_arxiv', ddl: 'ALTER TABLE article ADD COLUMN refs_arxiv TEXT' },
  { name: 'refs_doi', ddl: 'ALTER TABLE article ADD COLUMN refs_doi TEXT' },
  { name: 'shared_stable_id', ddl: 'ALTER TABLE article ADD COLUMN shared_stable_id TEXT' },
  { name: 'routed_similarity', ddl: 'ALTER TABLE article ADD COLUMN routed_similarity REAL' },
  { name: 'quality_rigor', ddl: 'ALTER TABLE article ADD COLUMN quality_rigor INTEGER' },
  { name: 'quality_evidence', ddl: 'ALTER TABLE article ADD COLUMN quality_evidence INTEGER' },
  { name: 'digested_at', ddl: 'ALTER TABLE article ADD COLUMN digested_at TEXT' },
];

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
  refs_arxiv: string | null;
  refs_doi: string | null;
  shared_stable_id: string | null;
  routed_similarity: number | null;
  quality_rigor: number | null;
  quality_evidence: number | null;
  digested_at: string | null;
}

function parseDate(s: string | null): Date | null {
  return s ? new Date(s + 'Z') : null;
}

/**
 * Half-open UTC range covering a LOCAL calendar day, in the
 * 'YYYY-MM-DD HH:MM:SS' text form collected_at is stored in (lexicographically
 * comparable). `new Date(y, m-1, d)` is local midnight; toISOString converts
 * it to the corresponding UTC instant. Null on a malformed date string.
 */
function localDayRangeUtc(localYmd: string): { start: string; end: string } | null {
  const [y, m, d] = localYmd.split('-').map(Number);
  if (!y || !m || !d) return null;
  const fmt = (dt: Date): string => dt.toISOString().slice(0, 19).replace('T', ' ');
  return {
    start: fmt(new Date(y, m - 1, d, 0, 0, 0, 0)),
    end: fmt(new Date(y, m - 1, d + 1, 0, 0, 0, 0)),
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSourceUrl(url: string | null, source: string | null): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  if (/^zenodo$/i.test(source ?? '') && /^\d+$/.test(raw)) {
    return `https://zenodo.org/records/${raw}`;
  }
  return raw;
}

export class ArticleStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.applyColumnMigrations();
  }

  private applyColumnMigrations(): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(article)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const m of COLUMN_MIGRATIONS) {
      if (!existing.has(m.name)) this.db.exec(m.ddl);
    }
  }

  /**
   * Shared dedup check for both upsert paths. Returns the duplicate verdict
   * or null when the article is new. url_hash wins over title_hash (a URL
   * match is definitive; a title match is conservative first-pass dedup).
   */
  private findDuplicate(
    urlHash: string | null,
    titleHash: string,
  ): { result: 'duplicate-url' | 'duplicate-title'; id: number } | null {
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
    return null;
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
    const normalizedUrl = normalizeUrl(normalizeSourceUrl(input.url, input.source));
    const urlHash = normalizedUrl ? sha256(normalizedUrl) : null;
    const titleHash = sha256(normalizeTitle(input.title));

    const dup = this.findDuplicate(urlHash, titleHash);
    if (dup) return dup;

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
   * Insert a row routed from the shared layer. Same dedup contract as
   * upsertPending (url wins, title fallback) so re-routing an article a
   * user already has — from an earlier cycle, or from the pre-multi-tenant
   * era — is a clean no-op.
   *
   * collected_from is fixed to 'shared-router' for audit; the rich summary
   * is stored as the snippet (it IS the body the librarian works from).
   */
  upsertRouted(input: RoutedArticleInput): { result: UpsertResult; id: number | null } {
    const normalizedUrl = normalizeUrl(normalizeSourceUrl(input.url, input.source));
    const urlHash = normalizedUrl ? sha256(normalizedUrl) : null;
    const titleHash = sha256(normalizeTitle(input.title));

    const dup = this.findDuplicate(urlHash, titleHash);
    if (dup) return dup;

    const stmt = this.db.prepare(
      `INSERT INTO article (url, url_hash, title, title_hash, source, field, snippet,
                            collected_at, collected_from,
                            refs_arxiv, refs_doi, shared_stable_id, routed_similarity,
                            quality_rigor, quality_evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), 'shared-router', ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      normalizedUrl,
      urlHash,
      input.title,
      titleHash,
      input.source,
      input.field,
      input.summary,
      input.collectedAt ? input.collectedAt.toISOString().slice(0, 19).replace('T', ' ') : null,
      JSON.stringify(input.refsArxiv),
      JSON.stringify(input.refsDoi),
      input.sharedStableId,
      input.routedSimilarity,
      input.qualityRigor ?? null,
      input.qualityEvidence ?? null,
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

  /**
   * Every 'done' article whose page_paths JSON contains the given vault-relative
   * path. Drives the source-URL backfill: walk the wiki, look up which articles
   * informed each page, append a ## Sources section with their URLs.
   *
   * page_paths is a JSON array of strings; each element is wrapped in double
   * quotes by JSON encoding, so a LIKE on the quoted form is a precise match
   * (no false positives from substring overlap with other paths).
   */
  findByPagePath(path: string): ArticleRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM article
         WHERE status = 'done' AND page_paths LIKE ?
         ORDER BY collected_at ASC, id ASC`,
      )
      .all(`%"${path}"%`) as RawRow[];
    return rows.map(toArticleRow);
  }

  /**
   * Look up the article whose URL is the canonical arxiv abs page for `arxivId`.
   * Version-agnostic: input '2605.03823v2' matches a row stored as
   * '.../abs/2605.03823' or '.../abs/2605.03823v1'. Old-style ids like
   * 'cs.AI/0501001' also work.
   */
  findByArxivId(arxivId: string): ArticleRow | null {
    const bare = arxivId.trim().replace(/v\d+$/i, '');
    if (!bare) return null;
    // Anchor to '/abs/{id}' followed by end-of-string, version suffix, query,
    // or fragment. Avoids matching '/abs/2605.038234' when looking up
    // '/abs/2605.03823'.
    const needle = `/abs/${bare}`;
    const row = this.db
      .prepare(
        `SELECT * FROM article
         WHERE url LIKE ? OR url LIKE ? OR url LIKE ? OR url LIKE ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get(
        `%${needle}`,
        `%${needle}v%`,
        `%${needle}?%`,
        `%${needle}#%`,
      ) as RawRow | undefined;
    return row ? toArticleRow(row) : null;
  }

  /**
   * Look up by DOI. Accepts raw '10.1038/s41586-024-12345-6' or doi.org URL form.
   * Lookup is case-insensitive (DOIs are per RFC 3986).
   */
  findByDoi(doi: string): ArticleRow | null {
    const bare = doi
      .trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .toLowerCase();
    if (!bare) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM article
         WHERE LOWER(url) LIKE ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get(`%doi.org/${bare}%`) as RawRow | undefined;
    return row ? toArticleRow(row) : null;
  }

  /**
   * Lookup by URL through the same normalization the upsert paths hash with,
   * so any string form that would have deduped against a row finds that row.
   * url_hash is unique-when-present → at most one match.
   */
  findByUrl(url: string, source: string | null = null): ArticleRow | null {
    const normalized = normalizeUrl(normalizeSourceUrl(url, source));
    if (!normalized) return null;
    return this.findByUrlHash(sha256(normalized));
  }

  /**
   * Direct lookup by the existing url_hash column (sha256 of normalized URL).
   */
  findByUrlHash(urlHash: string): ArticleRow | null {
    const row = this.db
      .prepare(`SELECT * FROM article WHERE url_hash = ?`)
      .get(urlHash) as RawRow | undefined;
    return row ? toArticleRow(row) : null;
  }

  /**
   * Keyword search across article titles. Each whitespace-separated keyword
   * becomes its own LIKE clause AND'd together. Case-insensitive (titles
   * stored as-is, LIKE is case-insensitive in sqlite default).
   *
   * Used by the v3 librarian's source-scout to surface sibling source pages
   * the article being indexed should be linked to.
   */
  searchByTitle(keywords: string, limit: number = 10): ArticleRow[] {
    const terms = keywords
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    if (terms.length === 0) return [];
    // ESCAPE applies per-LIKE in sqlite; clauses must each carry the escape char.
    const where = terms.map(() => "title LIKE ? ESCAPE '\\'").join(' AND ');
    const params = terms.map((t) => `%${t.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const rows = this.db
      .prepare(
        `SELECT * FROM article
         WHERE ${where}
         ORDER BY collected_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as RawRow[];
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

  /**
   * Articles collected during a given LOCAL calendar day (YYYY-MM-DD in the
   * machine's local timezone), translated into the corresponding UTC range
   * for the SQL query. Use this from the digest, whose schedule and human
   * framing are local-time but whose `collected_at` column is UTC.
   *
   * Example: in PT, the PM digest fires at 18:30 local = 01:30/02:30 UTC the
   * next day. listByDate(utcToday) misses everything; listByLocalDate('PT
   * today') correctly spans 07:00 UTC today through 07:00 UTC tomorrow (PDT)
   * or 08:00 through 08:00 (PST).
   */
  listByLocalDate(localYmd: string): ArticleRow[] {
    const range = localDayRangeUtc(localYmd);
    if (!range) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM article WHERE collected_at >= ? AND collected_at < ?
         ORDER BY id ASC`,
      )
      .all(range.start, range.end) as RawRow[];
    return rows.map(toArticleRow);
  }

  /**
   * Same window as listByLocalDate, minus everything a previous digest
   * already consumed (`digested_at IS NULL`).
   *
   * This is what makes AM and PM different runs rather than the same run
   * twice: before `digested_at` existed both digests loaded the whole local
   * day and emailed the identical set of articles, so the PM mail was a
   * verbatim repeat of the AM mail plus whatever arrived in between.
   */
  listUndigestedByLocalDate(localYmd: string): ArticleRow[] {
    const range = localDayRangeUtc(localYmd);
    if (!range) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM article
         WHERE collected_at >= ? AND collected_at < ? AND digested_at IS NULL
         ORDER BY id ASC`,
      )
      .all(range.start, range.end) as RawRow[];
    return rows.map(toArticleRow);
  }

  /**
   * Stamp `digested_at` on the rows a digest consumed. Called by the digest's
   * email phase AFTER a successful send — a failed send must leave the rows
   * eligible for the next run, so this is deliberately not part of loading.
   *
   * Already-stamped rows are left alone (`digested_at IS NULL` guard) so a
   * re-run can't rewrite the timestamp of an older digest's articles. Runs in
   * one transaction, chunked under SQLite's bound-parameter limit.
   * Returns the number of rows newly stamped.
   */
  markDigested(ids: number[], at: Date = new Date()): number {
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
    if (unique.length === 0) return 0;
    const stamp = at.toISOString().slice(0, 19).replace('T', ' ');
    const CHUNK = 400;
    const tx = this.db.transaction((all: number[]) => {
      let changed = 0;
      for (let i = 0; i < all.length; i += CHUNK) {
        const chunk = all.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const result = this.db
          .prepare(
            `UPDATE article SET digested_at = ?
             WHERE id IN (${placeholders}) AND digested_at IS NULL`,
          )
          .run(stamp, ...chunk);
        changed += result.changes;
      }
      return changed;
    });
    return tx(unique) as number;
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

  /**
   * Roll a row back to 'pending' (clearing processed_at). Used by the
   * deadline-rollover path: if a librarian run hits its soft deadline,
   * the in-flight worker returns the row to the queue for the next run.
   */
  markPending(id: number): void {
    this.db
      .prepare(`UPDATE article SET status='pending', processed_at=NULL WHERE id=?`)
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
   * Full reset to 'pending' for the repair path: clears status_reason,
   * processed_at, AND page_paths, so the librarian regenerates the source
   * page from scratch (a lingering page_paths entry would leave the row
   * claiming a page the repair just deleted).
   */
  resetToPending(id: number): void {
    this.db
      .prepare(
        `UPDATE article SET status='pending', status_reason=NULL, processed_at=NULL,
                            page_paths='[]'
         WHERE id=?`,
      )
      .run(id);
  }

  /**
   * Hard-delete a row. Repair-only: removing the row frees its url_hash /
   * title_hash so a fresh inbox drop of the same article re-ingests instead
   * of dedup-skipping.
   */
  deleteById(id: number): void {
    this.db.prepare(`DELETE FROM article WHERE id=?`).run(id);
  }

  /**
   * Requeue terminal rows ('failed' | 'skipped') back to 'pending'.
   * Clears status_reason and processed_at; page_paths untouched — the
   * librarian's exists-check dedups against any pages a prior attempt wrote.
   * Returns the number of rows requeued.
   */
  requeueByStatus(filter: RequeueFilter): number {
    const where = filter.likeReason !== undefined
      ? `status=? AND status_reason LIKE ?`
      : `status=?`;
    const params = filter.likeReason !== undefined
      ? [filter.status, filter.likeReason]
      : [filter.status];
    const result = this.db
      .prepare(
        `UPDATE article SET status='pending', status_reason=NULL, processed_at=NULL
         WHERE ${where}`,
      )
      .run(...params);
    return result.changes;
  }

  /**
   * status_reason histogram for the rows requeueByStatus(filter) would touch.
   * Drives the admin dry-run report. Most-frequent first.
   */
  reasonHistogram(filter: RequeueFilter): Array<{ reason: string | null; count: number }> {
    const where = filter.likeReason !== undefined
      ? `status=? AND status_reason LIKE ?`
      : `status=?`;
    const params = filter.likeReason !== undefined
      ? [filter.status, filter.likeReason]
      : [filter.status];
    return this.db
      .prepare(
        `SELECT status_reason AS reason, COUNT(*) AS count FROM article
         WHERE ${where}
         GROUP BY status_reason ORDER BY count DESC, reason ASC`,
      )
      .all(...params) as Array<{ reason: string | null; count: number }>;
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
    refsArxiv: r.refs_arxiv ? JSON.parse(r.refs_arxiv) : null,
    refsDoi: r.refs_doi ? JSON.parse(r.refs_doi) : null,
    sharedStableId: r.shared_stable_id ?? null,
    routedSimilarity: r.routed_similarity ?? null,
    qualityRigor: r.quality_rigor ?? null,
    qualityEvidence: r.quality_evidence ?? null,
    digestedAt: parseDate(r.digested_at ?? null),
  };
}

/**
 * SharedArticleStore — sqlite-backed cache for the shared layer of the
 * multi-tenant pipeline. One row per article ever collected, regardless of
 * how many users it eventually routes to.
 *
 * Lifecycle: pending → enriched → summarized → embedded → routed
 *
 * The per-user pipelines have their own `article` table (existing
 * ArticleStore) in per-user DB files. Routing copies relevant fields from
 * here into matching per-user rows. The two layers stay decoupled — losing
 * one doesn't corrupt the other.
 *
 * File path defaults to `~/chiya-data/shared/articles.db` but is configurable
 * (passed in the constructor). Embeddings are stored as Float32 BLOBs;
 * ~6KB per row at qwen3-embed-8b's 1536 dims.
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { createHash } from 'crypto';

export type SharedStatus =
  | 'pending'
  | 'enriching'
  | 'enriched'
  | 'enrich-failed'
  | 'summarized'
  | 'embedded'
  | 'routed'
  | 'failed';

export interface SharedArticleRow {
  stableId: string;
  url: string;
  urlHash: string;
  title: string;
  source: string | null;
  field: string | null;
  queryLabels: string[];
  abstract: string | null;
  fulltext: string | null;
  summary: string | null;
  summaryEmbedding: number[] | null;
  refsArxiv: string[];
  refsDoi: string[];
  collectedAt: Date;
  enrichedAt: Date | null;
  summarizedAt: Date | null;
  routedAt: Date | null;
  status: SharedStatus;
  statusReason: string | null;
}

export interface SharedArticleInput {
  stableId: string;
  url: string;
  title: string;
  source: string | null;
  field: string | null;
  queryLabels: string[];
  abstract: string | null;
}

export type UpsertResult = 'inserted' | 'duplicate';

/** Input shape for logRoutingDecisions — matches routing.ts's RoutingScore. */
export interface RoutingDecision {
  stableId: string;
  userHandle: string;
  similarity: number;
  routed: boolean;
  viaFloor: boolean;
}

export interface RoutingLogRow extends RoutingDecision {
  decidedAt: Date;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_article (
  stable_id          TEXT PRIMARY KEY,
  url                TEXT NOT NULL,
  url_hash           TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  source             TEXT,
  field              TEXT,
  query_labels       TEXT NOT NULL DEFAULT '[]',
  abstract           TEXT,
  fulltext           TEXT,
  summary            TEXT,
  summary_embedding  BLOB,
  refs_arxiv         TEXT NOT NULL DEFAULT '[]',
  refs_doi           TEXT NOT NULL DEFAULT '[]',
  collected_at       TEXT NOT NULL DEFAULT (datetime('now')),
  enriched_at        TEXT,
  summarized_at      TEXT,
  routed_at          TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  status_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_shared_status_collected
  ON shared_article(status, collected_at);

CREATE TABLE IF NOT EXISTS routing_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stable_id    TEXT NOT NULL,
  user_handle  TEXT NOT NULL,
  similarity   REAL NOT NULL,
  routed       INTEGER NOT NULL,
  via_floor    INTEGER NOT NULL DEFAULT 0,
  decided_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_log_user
  ON routing_log(user_handle, decided_at);
`;

interface RawRow {
  stable_id: string;
  url: string;
  url_hash: string;
  title: string;
  source: string | null;
  field: string | null;
  query_labels: string;
  abstract: string | null;
  fulltext: string | null;
  summary: string | null;
  summary_embedding: Buffer | null;
  refs_arxiv: string;
  refs_doi: string;
  collected_at: string;
  enriched_at: string | null;
  summarized_at: string | null;
  routed_at: string | null;
  status: SharedStatus;
  status_reason: string | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function parseDate(s: string | null): Date | null {
  return s ? new Date(s + 'Z') : null;
}

function decodeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  // better-sqlite3 hands us a Node Buffer; reinterpret as Float32Array.
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

function encodeEmbedding(vector: number[]): Buffer {
  const f32 = new Float32Array(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function deserializeRow(r: RawRow): SharedArticleRow {
  return {
    stableId: r.stable_id,
    url: r.url,
    urlHash: r.url_hash,
    title: r.title,
    source: r.source,
    field: r.field,
    queryLabels: JSON.parse(r.query_labels),
    abstract: r.abstract,
    fulltext: r.fulltext,
    summary: r.summary,
    summaryEmbedding: decodeEmbedding(r.summary_embedding),
    refsArxiv: JSON.parse(r.refs_arxiv),
    refsDoi: JSON.parse(r.refs_doi),
    collectedAt: new Date(r.collected_at + 'Z'),
    enrichedAt: parseDate(r.enriched_at),
    summarizedAt: parseDate(r.summarized_at),
    routedAt: parseDate(r.routed_at),
    status: r.status,
    statusReason: r.status_reason,
  };
}

export class SharedArticleStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /**
   * Insert a freshly-collected article. Dedup by url_hash — re-collecting
   * the same URL is a no-op. Status starts at 'pending'.
   *
   * If the article already exists, optionally merge in NEW query labels
   * (so the same article surfacing under a second matcha query annotates
   * the existing row rather than dropping the signal).
   */
  upsertCollected(input: SharedArticleInput): UpsertResult {
    const urlHash = sha256(input.url.trim());
    const existing = this.db
      .prepare('SELECT stable_id, query_labels FROM shared_article WHERE url_hash = ?')
      .get(urlHash) as { stable_id: string; query_labels: string } | undefined;

    if (existing) {
      // Merge query labels so we know all queries that surfaced this article.
      const existingLabels: string[] = JSON.parse(existing.query_labels);
      const merged = Array.from(new Set([...existingLabels, ...input.queryLabels]));
      if (merged.length !== existingLabels.length) {
        this.db
          .prepare('UPDATE shared_article SET query_labels = ? WHERE stable_id = ?')
          .run(JSON.stringify(merged), existing.stable_id);
      }
      return 'duplicate';
    }

    this.db
      .prepare(
        `INSERT INTO shared_article
            (stable_id, url, url_hash, title, source, field, query_labels, abstract)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.stableId,
        input.url.trim(),
        urlHash,
        input.title,
        input.source,
        input.field,
        JSON.stringify(input.queryLabels),
        input.abstract,
      );
    return 'inserted';
  }

  listByStatus(status: SharedStatus, limit: number): SharedArticleRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shared_article
          WHERE status = ?
          ORDER BY collected_at ASC
          LIMIT ?`,
      )
      .all(status, limit) as RawRow[];
    return rows.map(deserializeRow);
  }

  findByStableId(stableId: string): SharedArticleRow | null {
    const row = this.db
      .prepare('SELECT * FROM shared_article WHERE stable_id = ?')
      .get(stableId) as RawRow | undefined;
    return row ? deserializeRow(row) : null;
  }

  markEnriched(stableId: string, fulltext: string, refsArxiv: string[], refsDoi: string[]): void {
    this.db
      .prepare(
        `UPDATE shared_article
            SET status = 'enriched',
                status_reason = NULL,
                fulltext = ?,
                refs_arxiv = ?,
                refs_doi = ?,
                enriched_at = datetime('now')
          WHERE stable_id = ?`,
      )
      .run(fulltext, JSON.stringify(refsArxiv), JSON.stringify(refsDoi), stableId);
  }

  markEnrichFailed(stableId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE shared_article
            SET status = 'enrich-failed',
                status_reason = ?,
                enriched_at = datetime('now')
          WHERE stable_id = ?`,
      )
      .run(reason.slice(0, 500), stableId);
  }

  markSummarized(stableId: string, summary: string): void {
    this.db
      .prepare(
        `UPDATE shared_article
            SET status = 'summarized',
                status_reason = NULL,
                summary = ?,
                summarized_at = datetime('now')
          WHERE stable_id = ?`,
      )
      .run(summary, stableId);
  }

  markEmbedded(stableId: string, vector: number[]): void {
    this.db
      .prepare(
        `UPDATE shared_article
            SET status = 'embedded',
                status_reason = NULL,
                summary_embedding = ?
          WHERE stable_id = ?`,
      )
      .run(encodeEmbedding(vector), stableId);
  }

  markRouted(stableId: string): void {
    this.db
      .prepare(
        `UPDATE shared_article
            SET status = 'routed',
                status_reason = NULL,
                routed_at = datetime('now')
          WHERE stable_id = ?`,
      )
      .run(stableId);
  }

  markFailed(stableId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE shared_article SET status = 'failed', status_reason = ? WHERE stable_id = ?`,
      )
      .run(reason.slice(0, 500), stableId);
  }

  // ---- routing telemetry ----------------------------------------------------

  /**
   * Persist one routing pass's full score matrix. This is the data that lets
   * us tune thresholds against real similarity distributions instead of the
   * 4-sample experiment the default came from. One row per (article, user)
   * pair evaluated, routed or not.
   */
  logRoutingDecisions(decisions: readonly RoutingDecision[]): void {
    const insert = this.db.prepare(
      `INSERT INTO routing_log (stable_id, user_handle, similarity, routed, via_floor)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: readonly RoutingDecision[]) => {
      for (const d of rows) {
        insert.run(d.stableId, d.userHandle, d.similarity, d.routed ? 1 : 0, d.viaFloor ? 1 : 0);
      }
    });
    tx(decisions);
  }

  /**
   * Similarity samples for threshold tuning. Filter by user and/or a
   * time window (days back from now).
   */
  routingSimilarities(opts: { userHandle?: string; sinceDays?: number; limit?: number } = {}): RoutingLogRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.userHandle) {
      clauses.push('user_handle = ?');
      params.push(opts.userHandle);
    }
    if (opts.sinceDays !== undefined) {
      clauses.push(`decided_at >= datetime('now', ?)`);
      params.push(`-${opts.sinceDays} days`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts.limit ?? 10_000;
    const rows = this.db
      .prepare(
        `SELECT stable_id, user_handle, similarity, routed, via_floor, decided_at
           FROM routing_log ${where}
          ORDER BY decided_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as Array<{
        stable_id: string;
        user_handle: string;
        similarity: number;
        routed: number;
        via_floor: number;
        decided_at: string;
      }>;
    return rows.map((r) => ({
      stableId: r.stable_id,
      userHandle: r.user_handle,
      similarity: r.similarity,
      routed: r.routed === 1,
      viaFloor: r.via_floor === 1,
      decidedAt: new Date(r.decided_at + 'Z'),
    }));
  }

  countByStatus(): Record<SharedStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM shared_article GROUP BY status`)
      .all() as Array<{ status: SharedStatus; n: number }>;
    const out: Record<SharedStatus, number> = {
      pending: 0,
      enriching: 0,
      enriched: 0,
      'enrich-failed': 0,
      summarized: 0,
      embedded: 0,
      routed: 0,
      failed: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

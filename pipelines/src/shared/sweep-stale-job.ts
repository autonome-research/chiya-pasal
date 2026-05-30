/**
 * sweepStaleJobLock — clear stuck RUNNING job rows before acquireExclusive.
 *
 * acquireExclusive (in SqliteJobStore) does a simple
 * `SELECT id FROM job WHERE name = ? AND status = 'RUNNING'` — if any row
 * matches it returns null. There's no built-in stale detection, so if a
 * process dies between acquireExclusive and setCompleted/setFailed, the
 * RUNNING row sits there forever and every subsequent run noops out.
 *
 * This sweeper does one targeted UPDATE per pipeline before acquireExclusive:
 * any row with the same name in status RUNNING that's older than the
 * caller-supplied threshold is flipped to FAILED with a marker error so
 * the next acquireExclusive can succeed.
 *
 * Threshold should sit comfortably ABOVE the systemd hard-kill window —
 * any RUNNING row older than that is necessarily orphaned, since a live
 * process can't have outrun systemd. Per-pipeline:
 *   - librarian: TimeoutStartSec=1200s (20m) → threshold 30m
 *   - digest:    TimeoutStartSec=900s  (15m) → threshold 25m
 *
 * Uses a short-lived second connection to the pipelines DB rather than
 * threading through the SqliteJobStore's private handle. WAL mode (set by
 * ArticleStore) makes concurrent readers/writers safe.
 */

import Database from 'better-sqlite3';

export function sweepStaleJobLock(
  dbPath: string,
  name: string,
  maxAgeMinutes: number,
): number {
  const db = new Database(dbPath);
  try {
    const result = db
      .prepare(
        `UPDATE job
           SET status = 'FAILED',
               error = 'swept-stale-lock: process died without releasing lock',
               completed_at = datetime('now')
         WHERE name = ?
           AND status = 'RUNNING'
           AND started_at < datetime('now', ?)`,
      )
      .run(name, `-${maxAgeMinutes} minutes`);
    return result.changes;
  } finally {
    db.close();
  }
}

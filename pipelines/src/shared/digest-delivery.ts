import Database from 'better-sqlite3';

interface JobEventRow {
  input: string;
  data: string;
}

interface DigestJobInput {
  date?: unknown;
}

interface PipelineEventData {
  agent?: unknown;
  action?: unknown;
}

/**
 * Return true when a prior chiya-digest job for this local date recorded a
 * successful email-send event. This is the daily idempotency guard used by the
 * full-cycle timer: if the machine wakes late or the service is manually
 * retried, collect/intake/librarian can still run safely, but the digest email
 * is not delivered twice for the same calendar day.
 */
export function hasSuccessfulDigestEmail(dbPath: string, localDate: string): boolean {
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT j.input AS input, e.data AS data
           FROM job j
           JOIN event e ON e.job_id = j.id
          WHERE j.name = 'chiya-digest'
            AND e.event_type = 'agent_activity'
          ORDER BY e.id DESC`,
      )
      .all() as JobEventRow[];

    for (const row of rows) {
      const input = safeJson<DigestJobInput>(row.input);
      if (input?.date !== localDate) continue;

      const data = safeJson<PipelineEventData>(row.data);
      if (data?.agent === 'email-send' && data.action === 'sent') return true;
    }
    return false;
  } catch (err) {
    // Fresh databases may not have thread-phase tables yet. In that case there
    // cannot be a prior delivery, so allow the digest to proceed.
    if (isMissingTableError(err)) return false;
    throw err;
  } finally {
    db.close();
  }
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such table: (job|event)/i.test(message);
}

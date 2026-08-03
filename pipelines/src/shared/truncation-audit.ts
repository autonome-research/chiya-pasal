/**
 * Truncation audit — the standing detector for the "stale output cap" class.
 *
 * Four times in one week a maxTokens constant sized for one model became
 * silently wrong when the dependency moved: digest classify/draft (800/2500,
 * sized for non-reasoning gemma4:e4b — after the qwen3 switch the hidden
 * reasoning pass ate the whole cap and classify force-skipped EVERY article),
 * then the reviewer's hardcoded 2500, which the 6k-char topic vocabulary made
 * worse — 31 articles deferred on `truncated` in one evening. None of these
 * threw. They degraded data quality for weeks while every job reported
 * COMPLETED.
 *
 * Truncation IS already recorded, just never aggregated. This module counts it
 * per agent from the two places it durably lands, so `doctor` can say "the
 * reviewer truncates on 12% of articles" instead of nobody noticing until a
 * digest looks thin.
 *
 * Where the evidence actually lives (verified against the live velvet
 * `.chiya-pipelines.db` on 2026-08-02, 3.6k events / 24k article rows):
 *
 *  - The thread-phase `event` log carries phase-level truncation warnings —
 *    e.g. draft-sections' "digest section draft truncated twice, used
 *    deterministic fallback: <bucket>" and job-level `error` events. This is
 *    the preferred source: it is per-run and attributable to a phase.
 *  - The reviewer's truncation is NOT in the event log at all (0 events match
 *    `reviewer-failed`, against 30 article rows that do). SO WE SAY IT PLAINLY:
 *    reviewer truncation is only observable through `article.status_reason`,
 *    which carries the deferral marker written by `reviewerFailureReason()` in
 *    src/phases/reviewer.ts. That column is the ground truth for this agent.
 *
 * Two traps this module is written around:
 *
 *  1. `status_reason LIKE '%truncat%'` is WRONG. The column also holds
 *     LLM-authored skip prose — "the snippet is truncated and lacks technical
 *     depth" — 11 such rows live today. Matching the substring counts the
 *     model's opinion about an article as a cap failure. Only the structured
 *     `<phase>-failed (attempt N): <error>` marker is machine-written, so only
 *     that is matched. (Same shape of mistake as the repair-error-summaries
 *     80-char snippet threshold: a heuristic over free text that silently
 *     changed meaning underneath us.)
 *  2. `data` events are excluded. The lint report payload contains a
 *     `truncatedAt: 2000` field describing its OWN list clipping, which has
 *     nothing to do with a model's output budget.
 *
 * The window is a ROW COUNT, not a time range: this module reads no clock and
 * opens no socket, so the audit is deterministic and testable. Callers that
 * want a time window pass `since`.
 *
 * THE WINDOW IS PER AGENT, and that is not a detail. A single global "most
 * recent N events" window is itself an instance of the failure class this
 * module polices: it silently assumes every phase fires at a similar rate.
 * They do not. The librarian runs every 10 minutes and the digest twice a day,
 * so on the live velvet DB the most recent 500 narration events covered 56
 * librarian jobs and exactly ONE digest run — `draft-sections 1/1 runs`, below
 * TRUNCATION_MIN_SAMPLE, unable to escalate no matter how bad it got. Over the
 * full history the same data reads `draft-sections 9/12 runs (75%)`: a live,
 * ongoing FAIL that the global window rendered invisible. So each agent gets
 * its own trailing window of runs, and the raw row limit is only a bound on
 * how much of the log is read, never the semantic window.
 */

import Database from 'better-sqlite3';

/** Event types whose payloads carry human-readable phase/agent narration.
 *  `data` is deliberately absent — see the header. */
const NARRATION_EVENT_TYPES = ['phase', 'error', 'agent_activity'] as const;

/** Free-text truncation marker used by every phase that reports a `length`
 *  finishReason (digest draft, summarize, scouts, router, reviewer). */
const TRUNCATION_TEXT_RE = /truncat/i;

/** The machine-written deferral marker: `reviewer-failed (attempt 2): truncated`.
 *  Format owned by `reviewerFailureReason()` in src/phases/reviewer.ts; kept as
 *  a local regex because shared/ must not import from phases/. Generic in the
 *  phase name so a future `<phase>-failed` adopter is counted for free. */
const FAILURE_MARKER_RE = /^([a-z0-9][a-z0-9-]*)-failed \(attempt \d+\): (.+)$/i;

/** Agents whose denominator must exist even at zero truncations, otherwise the
 *  check goes silent exactly when it is healthy and we cannot tell "0%" from
 *  "not measured". Today only the reviewer writes the marker. */
const STATUS_REASON_AGENTS = ['reviewer'] as const;

export interface TruncationAuditOptions {
  /** Article rows scanned. A row-count window keeps this clock-free. */
  sampleSize?: number;
  /** Trailing runs kept PER AGENT — the semantic window for the event log.
   *  See the header: a global row window hides low-frequency phases. */
  runsPerAgent?: number;
  /** Hard bound on event rows read, not a window. Big enough that a twice-daily
   *  phase still reaches `runsPerAgent`, small enough to stay a cheap read. */
  eventScanLimit?: number;
  /** Optional ISO cutoff applied to `event.created_at`; the CALLER reads the
   *  clock so this module stays pure. */
  since?: string;
}

export interface AgentTruncation {
  /** Phase name (`draft-sections`), agent_activity agent, or `reviewer`. */
  agent: string;
  /** What one unit of `total` means — event-log rows count whole runs, the
   *  status_reason source counts individual articles. Mixed on purpose: those
   *  are the units each source actually records. */
  unit: 'run' | 'article';
  source: 'event-log' | 'article-status';
  truncated: number;
  total: number;
  /** truncated/total, 0..1, rounded to 3dp. 0 when total is 0. */
  rate: number;
}

export interface TruncationAudit {
  byAgent: AgentTruncation[];
  windowDescription: string;
  /** Set when nothing could be audited (missing DB, missing tables, no
   *  history). Never an error: a fresh tenant has no history and that is not
   *  a health problem. */
  skipped?: string;
}

/** A narration event, already narrowed to the columns the audit reads. */
export interface AuditEventRow {
  job_id: string;
  event_type: string;
  /** Raw thread-phase JSON payload. Unparseable rows are ignored, not fatal. */
  data: string;
}

const DEFAULT_SAMPLE_SIZE = 500;

/**
 * Runs kept per agent. 40 covers ~20 days of a twice-daily digest and ~7 hours
 * of the 10-minute librarian — recent enough that a rate describes the CURRENT
 * model/prompt, long enough to clear TRUNCATION_MIN_SAMPLE for the slow phases.
 * Raise it if a phase moves to a slower cadence than the digest's.
 */
export const DEFAULT_RUNS_PER_AGENT = 40;

/**
 * Ceiling on event rows read per audit — a cost bound, not a window. At the
 * live rate (~3k narration events per week) this reaches back roughly a month,
 * which is what a twice-daily phase needs to fill DEFAULT_RUNS_PER_AGENT.
 * Reads stay a few tens of ms on a local sqlite file.
 */
export const DEFAULT_EVENT_SCAN_LIMIT = 20000;

/**
 * WARN at a sustained 10%, FAIL at 35%.
 *
 * A nonzero rate is NOT alarming: reviewer deferral is a designed retry path
 * (a truncated reviewer call returns the article to pending and it succeeds on
 * the next pass), and the live baseline sits near 3%. What the incidents
 * looked like is different in kind — the 2500-token reviewer deferred 31
 * articles in one evening, and the 800-token classifier skipped 100% of them.
 * A double-digit rate sustained across a window means the cap no longer fits
 * the model, not that a few calls ran long.
 */
export const TRUNCATION_WARN_RATE = 0.1;
export const TRUNCATION_FAIL_RATE = 0.35;

/** Below this many units a rate is noise (1 of 3 runs is 33% and means
 *  nothing), so small samples are reported but never escalate. */
export const TRUNCATION_MIN_SAMPLE = 10;

function rateOf(truncated: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((truncated / total) * 1000) / 1000;
}

/** Payload string fields that hold narration. Anything else (counts, keys) is
 *  ignored so a field NAMED truncatedAt cannot masquerade as an incident. */
function narrationText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['detail', 'message', 'warning', 'error', 'reason']) {
    const v = payload[key];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' | ');
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Pure core: fold already-read rows into the per-agent summary.
 *
 * Event rows must be in ASCENDING id order — attribution carries the last
 * `phase` seen within a job forward onto that job's `error`/`agent_activity`
 * rows, which is how a bare `{"type":"error","message":"digest section draft
 * truncated: …"}` gets credited to draft-sections. A window that starts
 * mid-job simply yields `unknown` for the orphaned head, which is honest.
 *
 * Ascending order is also what makes the per-agent trailing window correct:
 * each agent's job set is in first-seen order, so the last `runsPerAgent` of
 * it are that agent's most recent runs regardless of how noisy its neighbours
 * were.
 */
export function summarizeTruncation(
  events: AuditEventRow[],
  statusReasons: Array<string | null>,
  windowDescription: string,
  runsPerAgent: number = DEFAULT_RUNS_PER_AGENT,
): TruncationAudit {
  const runs = new Map<string, { jobs: Set<string>; truncatedJobs: Set<string> }>();
  const lastPhaseByJob = new Map<string, string>();

  for (const row of events) {
    const payload = parsePayload(row.data);
    if (!payload) continue;
    const phase = typeof payload.phase === 'string' ? payload.phase : null;
    if (phase) lastPhaseByJob.set(row.job_id, phase);
    const agentField = typeof payload.agent === 'string' ? payload.agent : null;
    const agent = phase ?? agentField ?? lastPhaseByJob.get(row.job_id) ?? 'unknown';

    let bucket = runs.get(agent);
    if (!bucket) {
      bucket = { jobs: new Set(), truncatedJobs: new Set() };
      runs.set(agent, bucket);
    }
    bucket.jobs.add(row.job_id);
    if (TRUNCATION_TEXT_RE.test(narrationText(payload))) bucket.truncatedJobs.add(row.job_id);
  }

  const keep = Math.max(1, runsPerAgent);
  const byAgent: AgentTruncation[] = [];
  for (const [agent, bucket] of runs) {
    // Trailing window per agent: Sets preserve insertion order, and events
    // arrived ascending, so the tail is this agent's most recent runs.
    const recent = [...bucket.jobs].slice(-keep);
    const kept = new Set(recent);
    const truncated = recent.filter((job) => bucket.truncatedJobs.has(job)).length;
    byAgent.push({
      agent,
      unit: 'run',
      source: 'event-log',
      truncated,
      total: kept.size,
      rate: rateOf(truncated, kept.size),
    });
  }

  if (statusReasons.length > 0) {
    const truncatedByAgent = new Map<string, number>();
    for (const agent of STATUS_REASON_AGENTS) truncatedByAgent.set(agent, 0);
    for (const reason of statusReasons) {
      if (!reason) continue;
      const m = FAILURE_MARKER_RE.exec(reason);
      if (!m) continue; // LLM prose about a truncated snippet is not a cap failure.
      if (!TRUNCATION_TEXT_RE.test(m[2]!)) continue;
      const agent = m[1]!.toLowerCase();
      truncatedByAgent.set(agent, (truncatedByAgent.get(agent) ?? 0) + 1);
    }
    for (const [agent, truncated] of truncatedByAgent) {
      byAgent.push({
        agent,
        unit: 'article',
        source: 'article-status',
        truncated,
        total: statusReasons.length,
        rate: rateOf(truncated, statusReasons.length),
      });
    }
  }

  byAgent.sort((a, b) => b.rate - a.rate || a.agent.localeCompare(b.agent) || a.source.localeCompare(b.source));

  if (byAgent.length === 0) {
    return { byAgent, windowDescription, skipped: 'no job events or article rows recorded yet' };
  }
  return { byAgent, windowDescription };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/**
 * Read-only audit of one tenant DB. Never throws for an absent or half-built
 * database: a tenant registered five minutes ago has no `event` table yet, and
 * that must read as "nothing to audit", not as a failing health check.
 */
export function auditTruncation(dbPath: string, options: TruncationAuditOptions = {}): TruncationAudit {
  const sampleSize = Math.max(1, options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const runsPerAgent = Math.max(1, options.runsPerAgent ?? DEFAULT_RUNS_PER_AGENT);
  const eventScanLimit = Math.max(1, options.eventScanLimit ?? DEFAULT_EVENT_SCAN_LIMIT);
  const windowSuffix = options.since ? ` since ${options.since}` : '';
  const windowDescription =
    `most recent ${sampleSize} article rows and each agent's most recent ` +
    `${runsPerAgent} runs (from up to ${eventScanLimit} job events)${windowSuffix}`;
  const empty = (skipped: string): TruncationAudit => ({ byAgent: [], windowDescription, skipped });

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return empty(`${dbPath} is not readable: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const hasEvent = tableExists(db, 'event');
    const hasArticle = tableExists(db, 'article');
    if (!hasEvent && !hasArticle) return empty(`${dbPath} has neither an event nor an article table`);

    let events: AuditEventRow[] = [];
    if (hasEvent) {
      const placeholders = NARRATION_EVENT_TYPES.map(() => '?').join(',');
      const sinceClause = options.since ? 'AND created_at >= ?' : '';
      const params: unknown[] = [...NARRATION_EVENT_TYPES];
      if (options.since) params.push(options.since);
      params.push(eventScanLimit);
      // DESC + LIMIT takes the RECENT window; reversed to ascending because
      // phase attribution carries forward through a job in event order.
      events = (db
        .prepare(
          `SELECT job_id, event_type, data FROM event
           WHERE event_type IN (${placeholders}) ${sinceClause}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(...params) as AuditEventRow[]).reverse();
    }

    let statusReasons: Array<string | null> = [];
    if (hasArticle) {
      // The deferral marker SURVIVES a later successful pass (live rows sit at
      // status='done' still carrying `reviewer-failed (attempt 1): truncated`),
      // so this measures "articles that hit truncation at least once in the
      // window" — a cap-fit signal, not a current backlog.
      statusReasons = (db
        // Only rows an agent actually ran on. Including 'pending' rows —
        // 291 of a 500-row sample on the live tenant — inflates the
        // denominator and hides the signal: the reviewer's real 12% read as
        // 5%, i.e. below the warn line, so this check would have stayed
        // silent through the very incident it was built for.
        .prepare(
          `SELECT status_reason FROM article
            WHERE status IN ('done','skipped','failed')
            ORDER BY id DESC LIMIT ?`,
        )
        .all(sampleSize) as Array<{ status_reason: string | null }>).map((r) => r.status_reason);
    }

    if (events.length === 0 && statusReasons.length === 0) {
      return empty(`${dbPath} has no job events or article rows yet`);
    }
    return summarizeTruncation(events, statusReasons, windowDescription, runsPerAgent);
  } catch (err) {
    return empty(`${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
  }
}

export interface TruncationVerdict {
  level: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
}

function describe(entry: AgentTruncation): string {
  return `${entry.agent} ${entry.truncated}/${entry.total} ${entry.unit}s (${Math.round(entry.rate * 100)}%)`;
}

/**
 * Map an audit onto doctor's levels. Entries below TRUNCATION_MIN_SAMPLE are
 * reported but cannot escalate, so a first run of three jobs never cries wolf.
 */
export function classifyTruncationAudit(audit: TruncationAudit): TruncationVerdict {
  if (audit.skipped) return { level: 'skip', detail: audit.skipped };

  const escalatable = audit.byAgent.filter((e) => e.total >= TRUNCATION_MIN_SAMPLE);
  const failing = escalatable.filter((e) => e.rate >= TRUNCATION_FAIL_RATE);
  const warning = escalatable.filter((e) => e.rate >= TRUNCATION_WARN_RATE && e.rate < TRUNCATION_FAIL_RATE);
  const worst = audit.byAgent.filter((e) => e.truncated > 0).slice(0, 3);
  const window = `${audit.windowDescription}`;

  // Agents that truncate below the escalation threshold are still named on a
  // fail/warn line: the operator triaging one bad cap wants the whole picture,
  // not just the loudest agent (incident 2 was the one that got missed while
  // incident 1 was being fixed).
  const alsoNoted = (escalated: AgentTruncation[]): string => {
    const rest = worst.filter((e) => !escalated.includes(e));
    return rest.length > 0 ? `; also truncating: ${rest.map(describe).join(', ')}` : '';
  };

  if (failing.length > 0) {
    return {
      level: 'fail',
      detail: `output cap likely too small: ${failing.map(describe).join(', ')}${alsoNoted(failing)} [${window}]`,
    };
  }
  if (warning.length > 0) {
    return {
      level: 'warn',
      detail: `sustained truncation: ${warning.map(describe).join(', ')}${alsoNoted(warning)} [${window}]`,
    };
  }
  // Below-threshold truncation is still printed: the operator reading `doctor`
  // after a model swap wants the number, not just the absence of an alarm.
  const tail = worst.length > 0 ? `below thresholds: ${worst.map(describe).join(', ')}` : 'no truncation recorded';
  return { level: 'ok', detail: `${tail} [${window}]` };
}

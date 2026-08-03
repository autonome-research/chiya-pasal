import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  auditTruncation,
  classifyTruncationAudit,
  DEFAULT_RUNS_PER_AGENT,
  summarizeTruncation,
  TRUNCATION_FAIL_RATE,
  TRUNCATION_MIN_SAMPLE,
  TRUNCATION_WARN_RATE,
  type AuditEventRow,
} from '../src/shared/truncation-audit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-trunc-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function phaseEvent(jobId: string, phase: string, detail: string): AuditEventRow {
  return { job_id: jobId, event_type: 'phase', data: JSON.stringify({ type: 'phase', phase, detail }) };
}

const WINDOW = 'test window';

describe('summarizeTruncation — event log', () => {
  it('counts runs with at least one truncation, not truncation events', () => {
    const events: AuditEventRow[] = [
      phaseEvent('j1', 'draft-sections', 'drafting 3 article sections (45/39/37) + library-updates'),
      phaseEvent('j1', 'draft-sections', 'digest section draft truncated twice, used deterministic fallback: 📚 New & Notable'),
      phaseEvent('j1', 'draft-sections', 'digest section draft truncated twice, used deterministic fallback: 🔄 Follow-ups'),
      phaseEvent('j2', 'draft-sections', 'drafting 3 article sections (0/0/0) + library-updates'),
    ];
    const audit = summarizeTruncation(events, [], WINDOW);
    expect(audit.byAgent).toEqual([
      { agent: 'draft-sections', unit: 'run', source: 'event-log', truncated: 1, total: 2, rate: 0.5 },
    ]);
    expect(audit.windowDescription).toBe(WINDOW);
    expect(audit.skipped).toBeUndefined();
  });

  it('credits a bare error event to the last phase seen in that job', () => {
    const events: AuditEventRow[] = [
      phaseEvent('j1', 'draft-sections', 'drafting 3 article sections'),
      { job_id: 'j1', event_type: 'error', data: JSON.stringify({ type: 'error', message: 'digest section draft truncated: 📚 New & Notable' }) },
    ];
    const audit = summarizeTruncation(events, [], WINDOW);
    expect(audit.byAgent).toEqual([
      { agent: 'draft-sections', unit: 'run', source: 'event-log', truncated: 1, total: 1, rate: 1 },
    ]);
  });

  it('reports a healthy phase at rate 0 rather than omitting it', () => {
    const events: AuditEventRow[] = [
      phaseEvent('j1', 'plan-article-tree', 'planned=10 skipped=0 deferred=0'),
      phaseEvent('j2', 'plan-article-tree', 'planned=8 skipped=2 deferred=0'),
    ];
    const audit = summarizeTruncation(events, [], WINDOW);
    expect(audit.byAgent[0]).toMatchObject({ agent: 'plan-article-tree', truncated: 0, total: 2, rate: 0 });
  });

  it('ignores non-narration payload fields so lint-report truncatedAt is not an incident', () => {
    const events: AuditEventRow[] = [
      { job_id: 'j1', event_type: 'phase', data: JSON.stringify({ type: 'phase', phase: 'report-lint', detail: 'lint report written', truncatedAt: 2000 }) },
    ];
    expect(summarizeTruncation(events, [], WINDOW).byAgent[0].truncated).toBe(0);
  });

  it('ignores unparseable payloads instead of throwing', () => {
    const events: AuditEventRow[] = [
      { job_id: 'j1', event_type: 'phase', data: 'not json at all' },
      phaseEvent('j1', 'scan-vault', 'scanned 21800 pages'),
    ];
    expect(summarizeTruncation(events, [], WINDOW).byAgent).toHaveLength(1);
  });
});

describe('summarizeTruncation — per-agent window', () => {
  /** The live event mix: the librarian fires every 10 minutes, the digest
   *  twice a day, so a global row window is ~99% librarian. */
  function mixedTraffic(digestRuns: number, truncatedDigestRuns: number, librarianRuns: number): AuditEventRow[] {
    const events: AuditEventRow[] = [];
    for (let i = 0; i < librarianRuns; i++) {
      events.push(phaseEvent(`lib-${i}`, 'apply-article-plans', 'applied=10'));
      if (i % Math.ceil(librarianRuns / Math.max(1, digestRuns)) === 0) {
        const d = Math.floor(i / Math.ceil(librarianRuns / Math.max(1, digestRuns)));
        if (d < digestRuns) {
          events.push(phaseEvent(`dig-${d}`, 'draft-sections', 'drafting 3 article sections'));
          if (d < truncatedDigestRuns) {
            events.push(phaseEvent(`dig-${d}`, 'draft-sections', 'digest section draft truncated twice, used deterministic fallback: 📚'));
          }
        }
      }
    }
    return events;
  }

  it('measures a twice-daily phase against its OWN runs, not the librarian firehose', () => {
    // The live shape on 2026-08-03: draft-sections truncated on 9 of its last
    // 12 runs while a global 500-event window showed it as `1/1` — below
    // TRUNCATION_MIN_SAMPLE and therefore unable to escalate, which is how a
    // 75% failure rate stayed invisible.
    const audit = summarizeTruncation(mixedTraffic(12, 9, 500), [], WINDOW);
    expect(audit.byAgent.find((e) => e.agent === 'draft-sections')).toMatchObject({
      truncated: 9,
      total: 12,
    });
    expect(classifyTruncationAudit(audit).level).toBe('fail');
  });

  it('keeps each agent to its most RECENT runs, so a fixed cap stops showing as broken', () => {
    const events: AuditEventRow[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(phaseEvent(`old-${i}`, 'draft-sections', 'digest section draft truncated: 📚'));
    }
    for (let i = 0; i < 5; i++) {
      events.push(phaseEvent(`new-${i}`, 'draft-sections', 'drafting 3 article sections'));
    }
    // Whole history: 10/15. Trailing window of 5: 0/5 — the cap was raised.
    expect(summarizeTruncation(events, [], WINDOW, 15).byAgent[0]).toMatchObject({ truncated: 10, total: 15 });
    expect(summarizeTruncation(events, [], WINDOW, 5).byAgent[0]).toMatchObject({ truncated: 0, total: 5 });
  });

  it('defaults to a window long enough for a twice-daily phase to clear the min sample', () => {
    expect(DEFAULT_RUNS_PER_AGENT).toBeGreaterThanOrEqual(TRUNCATION_MIN_SAMPLE);
  });
});

describe('summarizeTruncation — article status_reason', () => {
  it('counts the reviewer deferral marker (the only place reviewer truncation lands)', () => {
    const reasons = [
      'reviewer-failed (attempt 1): truncated',
      'reviewer-failed (attempt 2): truncated',
      null,
      'kept',
    ];
    const audit = summarizeTruncation([], reasons, WINDOW);
    expect(audit.byAgent).toEqual([
      { agent: 'reviewer', unit: 'article', source: 'article-status', truncated: 2, total: 4, rate: 0.5 },
    ]);
  });

  it('does NOT count LLM prose that merely mentions a truncated snippet', () => {
    const reasons = [
      'The snippet is truncated and lacks technical depth, likely a survey text.',
      'Article content (the \'admission\' itself) was truncated in the fetch result.',
      'reviewer-failed (attempt 1): agent-error',
      null,
    ];
    const audit = summarizeTruncation([], reasons, WINDOW);
    expect(audit.byAgent[0]).toMatchObject({ agent: 'reviewer', truncated: 0, total: 4, rate: 0 });
  });

  it('keeps a zero-truncation reviewer row so "0%" is distinguishable from "not measured"', () => {
    const audit = summarizeTruncation([], ['kept', 'kept'], WINDOW);
    expect(audit.byAgent.map((e) => e.agent)).toContain('reviewer');
  });

  it('picks up any future <phase>-failed adopter of the marker', () => {
    const audit = summarizeTruncation([], ['router-failed (attempt 1): truncated', null], WINDOW);
    expect(audit.byAgent.find((e) => e.agent === 'router')).toMatchObject({ truncated: 1, total: 2 });
  });

  it('reports skipped when there is nothing at all to audit', () => {
    expect(summarizeTruncation([], [], WINDOW).skipped).toMatch(/no job events or article rows/);
  });
});

describe('classifyTruncationAudit', () => {
  const entry = (agent: string, truncated: number, total: number) => ({
    agent,
    unit: 'run' as const,
    source: 'event-log' as const,
    truncated,
    total,
    rate: truncated / total,
  });

  it('passes a low nonzero rate — reviewer deferral is a designed retry path', () => {
    const verdict = classifyTruncationAudit({ byAgent: [entry('reviewer', 9, 300)], windowDescription: WINDOW });
    expect(verdict.level).toBe('ok');
    expect(verdict.detail).toContain('reviewer 9/300');
  });

  it('warns at a sustained double-digit rate', () => {
    const total = 100;
    const verdict = classifyTruncationAudit({
      byAgent: [entry('reviewer', Math.ceil(TRUNCATION_WARN_RATE * total), total)],
      windowDescription: WINDOW,
    });
    expect(verdict.level).toBe('warn');
  });

  it('fails when a cap is plainly wrong for the model', () => {
    const total = 100;
    const verdict = classifyTruncationAudit({
      byAgent: [entry('draft-sections', Math.ceil(TRUNCATION_FAIL_RATE * total), total)],
      windowDescription: WINDOW,
    });
    expect(verdict.level).toBe('fail');
    expect(verdict.detail).toContain('output cap likely too small');
  });

  it('still names the other truncating agents on a fail line', () => {
    // Incident 2 was missed while incident 1 was being fixed; a fail line that
    // shows only the worst agent invites exactly that.
    const verdict = classifyTruncationAudit({
      byAgent: [entry('draft-sections', 9, 12), entry('reviewer', 25, 500)],
      windowDescription: WINDOW,
    });
    expect(verdict.level).toBe('fail');
    expect(verdict.detail).toContain('draft-sections 9/12');
    expect(verdict.detail).toContain('also truncating: reviewer 25/500');
  });

  it('does not escalate on a sample too small to mean anything', () => {
    const verdict = classifyTruncationAudit({
      byAgent: [entry('draft-sections', TRUNCATION_MIN_SAMPLE - 1, TRUNCATION_MIN_SAMPLE - 1)],
      windowDescription: WINDOW,
    });
    expect(verdict.level).toBe('ok');
  });

  it('maps a skipped audit onto the skip level', () => {
    const verdict = classifyTruncationAudit({ byAgent: [], windowDescription: WINDOW, skipped: 'no history' });
    expect(verdict).toEqual({ level: 'skip', detail: 'no history' });
  });
});

describe('auditTruncation — real sqlite', () => {
  function seed(path: string, opts: { event?: boolean; article?: boolean } = { event: true, article: true }): void {
    const db = new DatabaseCtor(path);
    if (opts.event) {
      db.exec(`CREATE TABLE event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      const ins = db.prepare('INSERT INTO event (job_id, event_type, data, created_at) VALUES (?,?,?,?)');
      ins.run('j1', 'phase', JSON.stringify({ type: 'phase', phase: 'draft-sections', detail: 'drafting 3 article sections' }), '2026-08-01 01:00:00');
      ins.run('j1', 'error', JSON.stringify({ type: 'error', message: 'digest section draft truncated: 📚 New & Notable' }), '2026-08-01 01:01:00');
      ins.run('j2', 'phase', JSON.stringify({ type: 'phase', phase: 'draft-sections', detail: 'drafting 3 article sections' }), '2026-08-02 01:00:00');
      ins.run('j3', 'data', JSON.stringify({ type: 'data', key: 'lint-report', value: { truncatedAt: 2000 } }), '2026-08-02 02:00:00');
    }
    if (opts.article) {
      db.exec(`CREATE TABLE article (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        status_reason TEXT
      )`);
      const ins = db.prepare('INSERT INTO article (title, status, status_reason) VALUES (?,?,?)');
      ins.run('a', 'done', 'reviewer-failed (attempt 1): truncated');
      ins.run('b', 'skipped', 'The snippet is truncated and lacks depth.');
      ins.run('c', 'done', null);
    }
    db.close();
  }

  it('reads both sources and excludes data events', () => {
    const path = join(dir, 'pipelines.db');
    seed(path);
    const audit = auditTruncation(path, { sampleSize: 100 });
    expect(audit.skipped).toBeUndefined();
    expect(audit.byAgent.find((e) => e.agent === 'draft-sections')).toEqual({
      agent: 'draft-sections', unit: 'run', source: 'event-log', truncated: 1, total: 2, rate: 0.5,
    });
    expect(audit.byAgent.find((e) => e.agent === 'reviewer')).toEqual({
      agent: 'reviewer', unit: 'article', source: 'article-status', truncated: 1, total: 3, rate: 0.333,
    });
    expect(audit.windowDescription).toContain('most recent 100');
  });

  it('honors the since cutoff the caller supplies (module reads no clock)', () => {
    const path = join(dir, 'pipelines.db');
    seed(path);
    const audit = auditTruncation(path, { sampleSize: 100, since: '2026-08-02 00:00:00' });
    expect(audit.byAgent.find((e) => e.agent === 'draft-sections')).toMatchObject({ truncated: 0, total: 1 });
    expect(audit.windowDescription).toContain('since 2026-08-02 00:00:00');
  });

  it('threads runsPerAgent through the sqlite path and names the window it used', () => {
    const path = join(dir, 'pipelines.db');
    seed(path);
    const audit = auditTruncation(path, { sampleSize: 100, runsPerAgent: 1 });
    // Only j2 (the later, clean draft-sections run) survives a window of one.
    expect(audit.byAgent.find((e) => e.agent === 'draft-sections')).toMatchObject({ truncated: 0, total: 1 });
    expect(audit.windowDescription).toContain("each agent's most recent 1 runs");
  });

  it('skips a missing database instead of throwing', () => {
    const audit = auditTruncation(join(dir, 'nope.db'));
    expect(audit.byAgent).toEqual([]);
    expect(audit.skipped).toMatch(/not readable/);
  });

  it('skips a database with neither table', () => {
    const path = join(dir, 'bare.db');
    const db = new DatabaseCtor(path);
    db.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
    db.close();
    expect(auditTruncation(path).skipped).toMatch(/neither an event nor an article table/);
  });

  it('audits an event-only database (article table not created yet)', () => {
    const path = join(dir, 'events-only.db');
    seed(path, { event: true, article: false });
    const audit = auditTruncation(path);
    expect(audit.skipped).toBeUndefined();
    expect(audit.byAgent.every((e) => e.source === 'event-log')).toBe(true);
  });

  it('skips an empty history', () => {
    const path = join(dir, 'empty.db');
    const db = new DatabaseCtor(path);
    db.exec('CREATE TABLE event (id INTEGER PRIMARY KEY, job_id TEXT, event_type TEXT, data TEXT, created_at TEXT)');
    // Mirrors the real schema (status included): the audit scopes its
    // denominator to rows an agent actually ran on, so a fixture without
    // `status` would test a table shape that cannot exist.
    db.exec(
      "CREATE TABLE article (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', status_reason TEXT)",
    );
    db.close();
    expect(auditTruncation(path).skipped).toMatch(/no job events or article rows/);
  });

  it('skips a file that is not a database at all', () => {
    const path = join(dir, 'garbage.db');
    writeFileSync(path, 'this is not sqlite');
    expect(auditTruncation(path).skipped).toBeTruthy();
  });
});

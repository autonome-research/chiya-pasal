import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';

import { ArticleStore } from '../src/shared/article-store.js';
import type { ChiyaEnv } from '../src/shared/env.js';
import type { DigestCtx } from '../src/shared/digest-types.js';
import { createDigestSelection, loadArticles } from '../src/phases/digest/load-articles.js';
import { emailSend } from '../src/phases/digest/publish.js';
import type { EmailMessage } from '../src/tools/email.js';

// AM/PM digest dedup: before `digested_at`, both timers loaded the same local
// calendar day and emailed the identical article set — the PM mail was the AM
// mail again. These tests pin the ledger: loaded → emailed → stamped, and the
// stamp lands only when the mail actually went out.

let dir: string;
let store: ArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-digest-dedup-'));
  store = new ArticleStore(join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Insert an article collected "now" (inside today's local window). */
function collect(title: string): number {
  const r = store.upsertPending({
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    source: 'test',
    field: 'AI/ML',
    snippet: 'snippet',
    collectedFrom: 'raw/inbox/test-articles.md',
    collectedAt: new Date(),
  });
  expect(r.result).toBe('inserted');
  return r.id!;
}

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function ctx(direction: 'AM' | 'PM'): DigestCtx {
  return {
    cache: new PipelineCache(),
    direction,
    date: todayLocal(),
    signal: new AbortController().signal,
    digest: 'rendered digest body',
  };
}

const env = { emailTo: 'reader@example.com' } as ChiyaEnv;

/** Records every send; `ok` decides success. */
function fakeSender(ok: boolean): {
  send: (msg: EmailMessage) => Promise<{ ok: boolean; output: string }>;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    send: async (msg) => {
      sent.push(msg);
      return ok ? { ok: true, output: 'sent' } : { ok: false, output: 'gws: connection refused' };
    },
  };
}

/** One whole digest run: load → (classify elided) → email. */
async function runDigest(
  direction: 'AM' | 'PM',
  ok: boolean,
): Promise<{ titles: string[]; sent: EmailMessage[] }> {
  const selection = createDigestSelection();
  const c = ctx(direction);
  await drain(loadArticles(store, selection).run(c));
  const sender = fakeSender(ok);
  await drain(
    emailSend(env, { send: sender.send, digested: { store, selection } }).run(c),
  );
  return { titles: (c.articles ?? []).map((a) => a.title), sent: sender.sent };
}

describe('ArticleStore digested_at', () => {
  it('defaults to null and surfaces on the row', () => {
    const id = collect('One');
    expect(store.getById(id)!.digestedAt).toBeNull();
  });

  it('markDigested stamps the given rows and returns the count', () => {
    const a = collect('One');
    const b = collect('Two');
    expect(store.markDigested([a, b])).toBe(2);
    expect(store.getById(a)!.digestedAt).toBeInstanceOf(Date);
    expect(store.getById(b)!.digestedAt).toBeInstanceOf(Date);
  });

  it('never re-stamps an already-digested row', () => {
    const id = collect('One');
    store.markDigested([id], new Date('2026-08-01T06:30:00Z'));
    const first = store.getById(id)!.digestedAt!;
    expect(store.markDigested([id], new Date('2026-08-01T18:30:00Z'))).toBe(0);
    expect(store.getById(id)!.digestedAt!.toISOString()).toBe(first.toISOString());
  });

  it('tolerates an empty and a duplicated id list', () => {
    const id = collect('One');
    expect(store.markDigested([])).toBe(0);
    expect(store.markDigested([id, id])).toBe(1);
  });

  it('marks well past the SQLite parameter limit in one call', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => collect(`Bulk ${i}`));
    expect(store.markDigested(ids)).toBe(1200);
    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(0);
  });

  it('listUndigestedByLocalDate is listByLocalDate minus the digested rows', () => {
    const a = collect('One');
    collect('Two');
    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(2);
    store.markDigested([a]);
    const left = store.listUndigestedByLocalDate(todayLocal());
    expect(left.map((r) => r.title)).toEqual(['Two']);
    // The unfiltered window is unchanged — the ledger doesn't hide history.
    expect(store.listByLocalDate(todayLocal())).toHaveLength(2);
  });

  it('returns nothing for a malformed date rather than the whole table', () => {
    collect('One');
    expect(store.listUndigestedByLocalDate('not-a-date')).toEqual([]);
  });
});

describe('load-articles', () => {
  it('records the loaded row ids in the selection', async () => {
    const a = collect('One');
    const b = collect('Two');
    const selection = createDigestSelection();
    await drain(loadArticles(store, selection).run(ctx('AM')));
    expect(selection.ids).toEqual([a, b]);
  });

  it('skips rows a previous digest already consumed', async () => {
    const a = collect('One');
    collect('Two');
    store.markDigested([a]);
    const c = ctx('AM');
    await drain(loadArticles(store).run(c));
    expect((c.articles ?? []).map((x) => x.title)).toEqual(['Two']);
  });

  it('still works without a selection (selection is optional plumbing)', async () => {
    collect('One');
    const c = ctx('AM');
    await drain(loadArticles(store).run(c));
    expect(c.articles).toHaveLength(1);
  });
});

describe('AM/PM digest dedup', () => {
  it('a second run the same day sees nothing new', async () => {
    collect('One');
    collect('Two');

    const am = await runDigest('AM', true);
    expect(am.titles).toEqual(['One', 'Two']);
    expect(am.sent).toHaveLength(1);

    const second = await runDigest('PM', true);
    expect(second.titles).toEqual([]);
    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(0);
  });

  it('new arrivals between AM and PM appear only in PM', async () => {
    collect('Morning A');
    collect('Morning B');

    const am = await runDigest('AM', true);
    expect(am.titles).toEqual(['Morning A', 'Morning B']);

    collect('Afternoon C');

    const pm = await runDigest('PM', true);
    expect(pm.titles).toEqual(['Afternoon C']);
  });

  it('a failed email leaves every row eligible for the next run', async () => {
    collect('One');
    collect('Two');

    const selection = createDigestSelection();
    const c = ctx('AM');
    await drain(loadArticles(store, selection).run(c));
    const sender = fakeSender(false);

    await expect(
      drain(emailSend(env, { send: sender.send, digested: { store, selection } }).run(c)),
    ).rejects.toThrow(/email-failed/);

    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(2);

    // The retry (next timer firing) sees the same two articles and, once the
    // send works, consumes them.
    const retry = await runDigest('PM', true);
    expect(retry.titles).toEqual(['One', 'Two']);
    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(0);
  });

  it('marks skipped articles too — a skip verdict consumed the article', async () => {
    // load-articles → email-send is the whole ledger path; classification
    // buckets never enter it, so every loaded row is stamped regardless of
    // whether it made the mail.
    collect('Noise');
    const run = await runDigest('AM', true);
    expect(run.titles).toEqual(['Noise']);
    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(0);
  });

  it('emails without a ledger when no digested deps are wired', async () => {
    collect('One');
    const c = ctx('AM');
    await drain(loadArticles(store).run(c));
    const sender = fakeSender(true);
    await drain(emailSend(env, { send: sender.send }).run(c));
    expect(sender.sent).toHaveLength(1);
    expect(store.listUndigestedByLocalDate(todayLocal())).toHaveLength(1);
  });
});

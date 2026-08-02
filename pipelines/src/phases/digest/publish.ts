/** Side-effecting digest publishing phases: log, commit, push, email. */

import { requireCtx, type Phase } from 'thread-phase';

import type { DigestCtx } from '../../shared/digest-types.js';
import type { ChiyaEnv } from '../../shared/env.js';
import { gwsEmailSend, type EmailMessage } from '../../tools/email.js';
import { GitOps } from '../../tools/git.js';
import { VaultFs } from '../../tools/vault.js';
import type { DigestSelection } from './load-articles.js';

export const appendLog = (vault: VaultFs): Phase<DigestCtx> => ({
  name: 'append-log',
  async *run(ctx) {
    const articles = requireCtx(ctx, 'articles', 'append-log');
    const classified = requireCtx(ctx, 'classified', 'append-log');
    const highlighted = classified.filter((c) => c.bucket !== 'skip').length;

    const entry = `## [${ctx.date}] digest | ${ctx.direction} digest curated — ${highlighted} highlights from ${articles.length} articles\n`;
    const marker = `## [${ctx.date}] digest | ${ctx.direction} digest curated`;
    const existingLog = await vault.readOptional('log.md');
    ctx.logEntry = entry;
    if (existingLog?.includes(marker)) {
      yield { type: 'agent_activity', agent: 'append-log', action: 'noop', detail: `already logged: ${marker}` };
      return;
    }
    await vault.append('log.md', '\n' + entry);
    yield { type: 'agent_activity', agent: 'append-log', action: 'appended', detail: entry.trim() };
  },
});

export const commitDigest = (git: GitOps): Phase<DigestCtx> => ({
  name: 'commit-digest',
  async *run(ctx) {
    const entry = requireCtx(ctx, 'logEntry', 'commit-digest');
    const summary = entry.trim().replace(/^##\s*/, '');
    const result = await git.commit(`digest: ${summary}`, ['log.md']);
    if (result.committed) {
      yield { type: 'agent_activity', agent: 'commit-digest', action: 'committed', detail: result.sha };
    } else {
      yield { type: 'agent_activity', agent: 'commit-digest', action: 'noop', detail: 'no changes' };
    }
  },
});

export const squashAndPush = (git: GitOps): Phase<DigestCtx> => ({
  name: 'squash-and-push',
  async *run(ctx) {
    const result = await git.squashAndPush(
      (count) => `chiya: ${count} runs since last push (digest ${ctx.date} ${ctx.direction})`,
    );
    ctx.pushed = result;
    if (result.pushed) {
      yield {
        type: 'agent_activity',
        agent: 'squash-and-push',
        action: 'pushed',
        detail: `${result.squashedCount} commits → ${result.sha?.slice(0, 7)}`,
      };
    } else {
      yield {
        type: 'agent_activity',
        agent: 'squash-and-push',
        action: 'noop',
        detail: 'nothing to push',
      };
    }
  },
});

/** The one ArticleStore capability email-send needs; keeps the tests fake-able. */
export interface DigestedMarker {
  markDigested(ids: number[]): number;
}

export interface EmailSendDeps {
  /** Transport seam — defaults to the real `gws gmail +send`. */
  send?: (msg: EmailMessage) => Promise<{ ok: boolean; output: string }>;
  /**
   * Consumption ledger. When present, every article this digest loaded (the
   * whole classified set — a `skip` verdict consumed the article just as
   * much as a highlight did) is stamped `digested_at` once the mail is out.
   */
  digested?: { store: DigestedMarker; selection: DigestSelection };
}

export const emailSend = (env: ChiyaEnv, deps: EmailSendDeps = {}): Phase<DigestCtx> => ({
  name: 'email-send',
  async *run(ctx) {
    const digest = requireCtx(ctx, 'digest', 'email-send');
    const html = ctx.digestHtml;
    const send = deps.send ?? gwsEmailSend;
    const result = await send({
      to: env.emailTo,
      subject: `🍵 Chiya Daily Digest — ${ctx.date} (${ctx.direction})`,
      body: html ?? digest,
      html: Boolean(html),
    });
    ctx.emailed = result;
    yield {
      type: 'agent_activity',
      agent: 'email-send',
      action: result.ok ? 'sent' : 'failed',
      detail: result.output.slice(0, 200),
    };
    if (!result.ok) {
      // Deliberately BEFORE marking: an article is only "digested" once the
      // user could actually read it. A failed send leaves every row eligible
      // for the next timer firing.
      throw new Error(`email-failed: ${result.output.slice(0, 500)}`);
    }

    if (deps.digested) {
      const marked = deps.digested.store.markDigested(deps.digested.selection.ids);
      yield {
        type: 'agent_activity',
        agent: 'email-send',
        action: 'marked-digested',
        detail: `${marked} article(s) stamped digested_at`,
      };
    }
  },
});

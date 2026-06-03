/** Side-effecting digest publishing phases: log, commit, push, email. */

import { requireCtx, type Phase } from 'thread-phase';

import type { DigestCtx } from '../../shared/digest-types.js';
import { hasSuccessfulDigestEmail } from '../../shared/digest-delivery.js';
import type { ChiyaEnv } from '../../shared/env.js';
import { gwsEmailSend } from '../../tools/email.js';
import { GitOps } from '../../tools/git.js';
import { VaultFs } from '../../tools/vault.js';

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

export interface EmailSendOptions {
  onceDaily?: boolean;
  dbPath?: string;
}

export const emailSend = (env: ChiyaEnv, options: EmailSendOptions = {}): Phase<DigestCtx> => ({
  name: 'email-send',
  async *run(ctx) {
    if (options.onceDaily && options.dbPath && hasSuccessfulDigestEmail(options.dbPath, ctx.date)) {
      ctx.emailed = { ok: true, output: 'skipped: email already sent for local date' };
      yield {
        type: 'agent_activity',
        agent: 'email-send',
        action: 'skipped',
        detail: `already sent for ${ctx.date}`,
      };
      return;
    }

    const digest = requireCtx(ctx, 'digest', 'email-send');
    const html = ctx.digestHtml;
    const result = await gwsEmailSend({
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
      throw new Error(`email-failed: ${result.output.slice(0, 500)}`);
    }
  },
});

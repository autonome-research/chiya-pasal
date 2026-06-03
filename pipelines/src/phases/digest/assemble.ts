/** Assemble the final digest markdown. */

import { requireCtx, type Phase } from 'thread-phase';

import type { DigestCtx } from '../../shared/digest-types.js';
import { renderDigestEmailHtml } from './render-html.js';

export const assemble: Phase<DigestCtx> = {
  name: 'assemble',
  async *run(ctx) {
    const sections = requireCtx(ctx, 'sections', 'assemble');
    const articles = requireCtx(ctx, 'articles', 'assemble');
    const classified = requireCtx(ctx, 'classified', 'assemble');
    const highlighted = classified.filter((c) => c.bucket !== 'skip').length;

    const body = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
    ctx.digest =
      `🍵 Chiya Daily Digest — ${ctx.date} (${ctx.direction})\n\n` +
      body +
      `\n\n---\nTotal articles collected: ${articles.length} | Curated highlights: ${highlighted}\n`;
    ctx.digestHtml = renderDigestEmailHtml(ctx);

    yield {
      type: 'data',
      key: 'digest-summary',
      value: { articles: articles.length, highlighted },
    };
  },
};

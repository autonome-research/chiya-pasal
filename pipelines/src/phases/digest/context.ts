/** Load vault context used by digest classification and drafting. */

import { promises as fs } from 'fs';
import { basename, join } from 'path';

import { type Phase } from 'thread-phase';

import type { DigestCtx, VaultContext } from '../../shared/digest-types.js';
import { VaultFs } from '../../tools/vault.js';

/** Caps on the topic inventory fed to the classifier prompt. */
export const TOPIC_SLUG_LIMIT = 400;
export const TOPIC_SLUG_CHAR_BUDGET = 6000;

/**
 * Topic page slugs from the flat wiki/topics/ tree, most recently modified
 * first. Capped by count and by the joined (", ") character budget so a
 * large vault cannot blow up the classifier's cached system prompt.
 * Tolerates a missing topics dir (empty inventory).
 */
export async function loadTopicSlugs(
  vault: VaultFs,
  limit: number = TOPIC_SLUG_LIMIT,
  charBudget: number = TOPIC_SLUG_CHAR_BUDGET,
): Promise<string[]> {
  const paths = await vault.list('wiki/topics/*.md');
  const stamped: Array<{ slug: string; mtimeMs: number }> = [];
  for (const path of paths) {
    try {
      const st = await fs.stat(join(vault.rootDir, path));
      stamped.push({ slug: basename(path, '.md'), mtimeMs: st.mtimeMs });
    } catch {
      // Deleted between list and stat — skip.
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const slugs: string[] = [];
  let joinedLen = 0;
  for (const { slug } of stamped.slice(0, limit)) {
    joinedLen += slug.length + (slugs.length > 0 ? 2 : 0);
    if (joinedLen > charBudget) break;
    slugs.push(slug);
  }
  return slugs;
}

export const loadContext = (
  vault: VaultFs,
  tenantInterests?: string[] | null,
): Phase<DigestCtx> => ({
  name: 'load-context',
  async *run(ctx) {
    const [claudeMd, tasteMd, logTail, focuses, research, profile, interests, topicSlugs] =
      await Promise.all([
        vault.read('CLAUDE.md'),
        vault.read('wiki/TASTE.md'),
        vault.readTail('log.md', 30),
        vault.listAndRead('wiki/user/focuses/*.md'),
        vault.listAndRead('wiki/research/*/STATUS.md'),
        vault.readOptional('wiki/user/profile.md'),
        vault.readOptional('wiki/user/interests.md'),
        loadTopicSlugs(vault),
      ]);

    const vc: VaultContext = {
      claudeMd,
      tasteMd,
      logTail,
      focuses,
      research,
      profile,
      interests,
      interestParagraphs: (tenantInterests ?? []).map((p) => p.trim()).filter((p) => p.length > 0),
      topicSlugs,
    };
    ctx.vault = vc;

    yield {
      type: 'phase',
      phase: 'load-context',
      detail: `${focuses.length} focus(es), ${research.length} active research project(s), ${topicSlugs.length} topic slug(s)`,
      counts: { focuses: focuses.length, research: research.length, topicSlugs: topicSlugs.length },
    };
  },
});

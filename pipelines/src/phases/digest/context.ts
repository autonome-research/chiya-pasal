/** Load vault context used by digest classification and drafting. */

import { type Phase } from 'thread-phase';

import type { DigestCtx, VaultContext } from '../../shared/digest-types.js';
import { VaultFs } from '../../tools/vault.js';

export const loadContext = (vault: VaultFs): Phase<DigestCtx> => ({
  name: 'load-context',
  async *run(ctx) {
    const [claudeMd, tasteMd, indexMd, logTail, focuses, research, profile, interests] =
      await Promise.all([
        vault.read('CLAUDE.md'),
        vault.read('wiki/TASTE.md'),
        vault.read('index.md'),
        vault.readTail('log.md', 30),
        vault.listAndRead('wiki/user/focuses/*.md'),
        vault.listAndRead('wiki/research/*/STATUS.md'),
        vault.readOptional('wiki/user/profile.md'),
        vault.readOptional('wiki/user/interests.md'),
      ]);

    const vc: VaultContext = {
      claudeMd,
      tasteMd,
      indexMd,
      logTail,
      focuses,
      research,
      profile,
      interests,
    };
    ctx.vault = vc;

    yield {
      type: 'phase',
      phase: 'load-context',
      detail: `${focuses.length} focus(es), ${research.length} active research project(s)`,
      counts: { focuses: focuses.length, research: research.length },
    };
  },
});

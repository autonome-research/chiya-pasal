import type { ToolExecutor } from 'thread-phase';

// Digest agents are pure classifiers/writers and receive no callable tools.
export const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

/**
 * Back-compat re-export. The digest's fast-tier budget now lives alongside
 * every other agent budget in src/shared/agent-budgets.ts — one place to
 * re-check when the inference target changes, which is what incidents 1 and 2
 * cost us. CHIYA_FAST_MAX_TOKENS still overrides it; new call sites should
 * import DIGEST_CLASSIFY_MAX_TOKENS / DIGEST_DRAFT_MAX_TOKENS directly.
 */
export { FAST_MAX_TOKENS } from '../../shared/agent-budgets.js';

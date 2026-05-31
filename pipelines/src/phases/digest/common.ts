import type { ToolExecutor } from 'thread-phase';

// Digest agents are pure classifiers/writers and receive no callable tools.
export const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

/**
 * Output-token budget for the digest's fast-tier LLM calls (classify, draft).
 *
 * The original 800/2500 caps were sized for a non-reasoning model
 * (gemma4:e4b). Reasoning models (e.g. qwen) emit a long hidden reasoning
 * pass before the final answer, so a small cap is consumed entirely by
 * reasoning and the call truncates (finishReason='length') before any JSON
 * or section text is produced — classify then force-skips every article and
 * draft throws. 4000 matches the librarian reviewer (same model) and leaves
 * ample room for reasoning + the small classifier JSON / section bullets.
 * Override with CHIYA_FAST_MAX_TOKENS for thriftier non-reasoning models.
 */
export const FAST_MAX_TOKENS = Math.max(
  256,
  Number(process.env.CHIYA_FAST_MAX_TOKENS ?? '4000') || 4000,
);

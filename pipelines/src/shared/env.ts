/**
 * Resolved environment for the chiya pipelines.
 *
 * Two inference targets, both default to tiny-emerson's vllm (qwen36) via
 * the SSH tunnel (localhost:11435 → tiny-emerson:9000). One model, one
 * endpoint — vllm pins the model in VRAM and serves it concurrently, so
 * no benefit to splitting the targets right now. The split exists in case
 * we want to point the fast tier at a smaller endpoint later.
 *
 * - `fast`  — digest classify/draft and librarian summary call. JSON-only
 *             output, no tools.
 * - `tools` — librarian router + scouts + reviewer. Must support OpenAI
 *             tool calling (qwen36 vllm on :9000 does; the PI wrapper on
 *             :8000 does not — see chiya-tunnel-tiny.service).
 *
 * VAULT_DIR is the only required env; the tiny-emerson tunnel must be up
 * (see systemd/chiya-tunnel-tiny.service).
 */

import { homedir } from 'os';
import { resolve } from 'path';

export interface InferenceTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChiyaEnv {
  vaultDir: string;
  vaultRemote: string;
  vaultBranch: string;
  emailTo: string;
  /** Fast remote (no tools). Used for triage / classifier / drafter. */
  fast: InferenceTarget;
  /** Tool-capable. Used for librarian upsert (vault read/write + web fetch). */
  tools: InferenceTarget;
}

export function loadChiyaEnv(): ChiyaEnv {
  // CHIYA_EMAIL_TO is the only required secret-ish var. Systemd loads it
  // via EnvironmentFile=-%h/chiya-library/pipelines/.env (see service
  // units); for local dev: `set -a && source .env && set +a` before
  // running. .env.example documents the expected keys.
  const emailTo = process.env.CHIYA_EMAIL_TO;
  if (!emailTo) {
    throw new Error(
      'CHIYA_EMAIL_TO is required. Set it in pipelines/.env (gitignored) ' +
        'or export it in your shell. See pipelines/.env.example.',
    );
  }
  return {
    vaultDir: resolve(process.env.VAULT_DIR ?? `${homedir()}/vault`),
    vaultRemote: process.env.VAULT_REMOTE ?? 'origin',
    vaultBranch: process.env.VAULT_BRANCH ?? 'main',
    emailTo,
    fast: {
      baseUrl: process.env.FAST_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.FAST_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.FAST_INFERENCE_MODEL ?? 'qwen36',
    },
    tools: {
      baseUrl: process.env.TOOLS_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.TOOLS_INFERENCE_API_KEY ?? 'not-needed',
      // qwen36 vllm on tiny-emerson:9000 (raw, not the :8000 wrapper).
      // Verified end-to-end: streaming + tool_calls deltas + finish_reason
      // 'tool_calls' on auto + required tool_choice.
      model: process.env.TOOLS_INFERENCE_MODEL ?? 'qwen36',
    },
  };
}

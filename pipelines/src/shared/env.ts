/**
 * Resolved environment for the chiya pipelines.
 *
 * Two inference targets — both currently route to tiny-emerson Ollama via
 * the SSH tunnel (localhost:11435 → tiny-emerson:11434). Same model
 * (gemma4:e4b) reused for both triage and upsert: it stays warm in VRAM,
 * no model-swap latency between the two phase types, supports tool calls
 * natively for upsert. tiny-emerson is configured to keep the model
 * resident (no eviction).
 *
 * - `fast`  — used for triage / classifier / drafter. JSON-only output,
 *             needs reasoning-trace headroom (~150-300 tokens).
 * - `tools` — used for the librarian's wikiUpsert phase. Same endpoint
 *             and model; just keeps the conceptual split in case we want
 *             to route them differently again.
 *
 * Local vLLM (qwen3.6-27b on this box) is no longer used by chiya-pipelines
 * directly — it remains for Hermes-driven jobs (vault-daily-lint).
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
  return {
    vaultDir: resolve(process.env.VAULT_DIR ?? `${homedir()}/vault`),
    vaultRemote: process.env.VAULT_REMOTE ?? 'origin',
    vaultBranch: process.env.VAULT_BRANCH ?? 'main',
    emailTo: process.env.CHIYA_EMAIL_TO ?? 'velvetmoon222999@gmail.com',
    fast: {
      baseUrl: process.env.FAST_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.FAST_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.FAST_INFERENCE_MODEL ?? 'gemma4:e4b',
    },
    tools: {
      baseUrl: process.env.TOOLS_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.TOOLS_INFERENCE_API_KEY ?? 'not-needed',
      // gemma4:26b is bigger and slower than e4b but much more reliable at
      // tool-calling — e4b confabulated 'created page X' without ever
      // calling vault_write. 26b actually executes tools.
      model: process.env.TOOLS_INFERENCE_MODEL ?? 'gemma4:26b',
    },
  };
}

/**
 * Resolved environment for the chiya pipelines.
 *
 * Two inference targets, picked by characteristic rather than location:
 *
 * - `fast` — sub-second startup, no tool-use support. Default: mb:8005's
 *   vLLM serving bu-30b-a3b-preview-NVFP4. Used for triage / classifier /
 *   drafter — anything that emits one short JSON or markdown blob.
 *
 * - `tools` — tool-call-capable, ~6s startup + fast generation. Default:
 *   tiny-emerson Ollama serving gemma4:e4b, reached via SSH tunnel at
 *   localhost:11435 → tiny-emerson:11434. Used for the librarian's
 *   wikiUpsert phase (vault_read/vault_write/web_fetch).
 *
 * Local vLLM (qwen3.6-27b on this box) is no longer used by chiya-pipelines
 * directly — it remains for Hermes-driven jobs (vault-daily-lint).
 *
 * VAULT_DIR is the only required env; both inference defaults work as long
 * as the tiny-emerson tunnel is up. See systemd/chiya-tunnel-tiny.service.
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
      baseUrl: process.env.FAST_INFERENCE_BASE_URL ?? 'http://mb:8005/v1',
      apiKey: process.env.FAST_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.FAST_INFERENCE_MODEL ?? 'bu-30b-a3b-preview-NVFP4',
    },
    tools: {
      baseUrl: process.env.TOOLS_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.TOOLS_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.TOOLS_INFERENCE_MODEL ?? 'gemma4:e4b',
    },
  };
}

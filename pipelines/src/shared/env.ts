/**
 * Resolved environment for the chiya pipelines.
 *
 * Inference targets are global — `fast` and `tools` route to the same
 * tiny-emerson vllm (qwen36) by default via the SSH tunnel at
 * localhost:11435. Per-user state (vault dir, email_to, vault remote) is
 * loaded from users.yaml when a handle is passed.
 *
 * - `fast`  — digest classify/draft. JSON-only output, no tools.
 * - `tools` — librarian router + scouts + reviewer. Must support OpenAI
 *             tool calling (qwen36 on :9000 does; the PI wrapper on :8000
 *             does not — see chiya-tunnel-tiny.service).
 * - `embed` — routing embeddings. qwen3-embed-8b on the spark k8s cluster,
 *             reached via kubectl port-forward (see chiya-embed.service).
 *
 * Two call modes:
 * - `loadChiyaEnv()`         — single-tenant legacy. Reads VAULT_DIR and
 *                              CHIYA_EMAIL_TO from process.env; used by
 *                              shell scripts and tests during migration.
 * - `loadChiyaEnvFor(handle)` — multi-tenant. Reads users.yaml and applies
 *                              the matching user's per-handle overrides.
 *
 * Both modes return the same ChiyaEnv shape so downstream code is uniform.
 */

import { homedir } from 'os';
import { resolve, join } from 'path';

import { findEnabledUser, loadUsersConfig, type User, type UsersConfig } from './users.js';

export interface InferenceTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChiyaEnv {
  /** Identifies the user this env was built for; null when single-tenant. */
  userHandle: string | null;
  vaultDir: string;
  vaultRemote: string;
  vaultBranch: string;
  emailTo: string;
  /** Per-user routing threshold; null for the single-tenant fallback. */
  routingThreshold: number | null;
  /** Per-user interest paragraphs (one per area); null for single-tenant fallback. */
  interests: string[] | null;
  fast: InferenceTarget;
  tools: InferenceTarget;
  embed: InferenceTarget;
  /** Root of the multi-tenant data dir (where per-user dirs live, and where
   *  the shared/ cache lives). Defaults to ~/chiya-data. */
  dataRoot: string;
}

function inferenceTargets(): Pick<ChiyaEnv, 'fast' | 'tools' | 'embed'> {
  return {
    fast: {
      baseUrl: process.env.FAST_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.FAST_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.FAST_INFERENCE_MODEL ?? 'qwen36',
    },
    tools: {
      baseUrl: process.env.TOOLS_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
      apiKey: process.env.TOOLS_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.TOOLS_INFERENCE_MODEL ?? 'qwen36',
    },
    embed: {
      baseUrl: process.env.EMBED_INFERENCE_BASE_URL ?? 'http://localhost:11437/v1',
      apiKey: process.env.EMBED_INFERENCE_API_KEY ?? 'not-needed',
      model: process.env.EMBED_INFERENCE_MODEL ?? 'qwen3-embed-8b',
    },
  };
}

function dataRoot(): string {
  return resolve(process.env.CHIYA_DATA_ROOT ?? `${homedir()}/chiya-data`);
}

/**
 * Single-tenant compatibility path. Reads VAULT_DIR, CHIYA_EMAIL_TO,
 * VAULT_REMOTE, VAULT_BRANCH directly from process.env. The multi-tenant
 * entry points use loadChiyaEnvFor instead.
 */
export function loadChiyaEnv(): ChiyaEnv {
  const emailTo = process.env.CHIYA_EMAIL_TO;
  if (!emailTo) {
    throw new Error(
      'CHIYA_EMAIL_TO is required for single-tenant mode. Set it in pipelines/.env ' +
        'or use loadChiyaEnvFor(handle) with users.yaml.',
    );
  }
  return {
    userHandle: null,
    vaultDir: resolve(process.env.VAULT_DIR ?? `${homedir()}/vault`),
    vaultRemote: process.env.VAULT_REMOTE ?? 'origin',
    vaultBranch: process.env.VAULT_BRANCH ?? 'main',
    emailTo,
    routingThreshold: null,
    interests: null,
    dataRoot: dataRoot(),
    ...inferenceTargets(),
  };
}

/**
 * Multi-tenant: build a ChiyaEnv scoped to one user from users.yaml.
 *
 * Per-user vault dir defaults to <dataRoot>/users/<handle>/vault. The
 * users.yaml controls the user's email, vault remote, interests, and
 * optional threshold override.
 */
export function loadChiyaEnvFor(handle: string, configOverride?: UsersConfig): ChiyaEnv {
  const config = configOverride ?? loadUsersConfig();
  const user = findEnabledUser(config, handle);
  return envFromUser(user);
}

export function envFromUser(user: User): ChiyaEnv {
  const root = dataRoot();
  return {
    userHandle: user.handle,
    vaultDir: join(root, 'users', user.handle, 'vault'),
    vaultRemote: user.vaultRemote,
    vaultBranch: user.vaultBranch,
    emailTo: user.emailTo,
    routingThreshold: user.threshold,
    interests: user.interests,
    dataRoot: root,
    ...inferenceTargets(),
  };
}

/** Path to the shared layer's SQLite cache. */
export function sharedDbPath(env: ChiyaEnv): string {
  return join(env.dataRoot, 'shared', 'articles.db');
}

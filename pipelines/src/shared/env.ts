/**
 * Resolved environment for the chiya pipelines.
 *
 * VAULT_DIR is the only required env. Inference defaults are inherited from
 * thread-phase's loadInferenceConfig() — no need to re-declare here.
 */

import { homedir } from 'os';
import { resolve } from 'path';

export interface ChiyaEnv {
  vaultDir: string;
  vaultRemote: string;
  vaultBranch: string;
  emailTo: string;
}

export function loadChiyaEnv(): ChiyaEnv {
  return {
    vaultDir: resolve(process.env.VAULT_DIR ?? `${homedir()}/vault`),
    vaultRemote: process.env.VAULT_REMOTE ?? 'origin',
    vaultBranch: process.env.VAULT_BRANCH ?? 'main',
    emailTo: process.env.CHIYA_EMAIL_TO ?? 'velvetmoon222999@gmail.com',
  };
}

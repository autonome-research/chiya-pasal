/**
 * User configuration loader for the multi-tenant pipelines.
 *
 * The shared layer (collect → enrich → summarize → route) treats users as
 * routing targets; the per-user layer (librarian / digest) iterates over
 * enabled users from this file. The YAML schema is the source of truth —
 * the admin CLI manipulates it; the pipelines read it; nothing else owns
 * tenant state.
 *
 * File path: pipelines/config/users.yaml (gitignored — contains contact
 * info). A `users.yaml.example` sibling documents the schema.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_THRESHOLD } from './routing.js';

export interface User {
  handle: string;
  name: string;
  emailTo: string;
  /** Vault git remote (SSH or HTTPS URL the server bot can push to). */
  vaultRemote: string;
  vaultBranch: string;
  /**
   * Paragraph-length description of the user's research interests. This
   * is embedded by the routing layer; bare keyword lists won't work — see
   * routing.ts for why.
   */
  interests: string;
  /** Optional override of the global default routing threshold. */
  threshold: number;
  enabled: boolean;
  /** Informational only. ISO date string when the user joined. */
  onboarded: string | null;
}

export interface UsersConfig {
  defaultThreshold: number;
  users: User[];
}

interface RawUser {
  handle: unknown;
  name: unknown;
  email_to: unknown;
  vault_remote: unknown;
  vault_branch?: unknown;
  interests: unknown;
  threshold?: unknown;
  enabled?: unknown;
  onboarded?: unknown;
}

interface RawConfig {
  default_threshold?: unknown;
  users?: unknown;
}

class UsersConfigError extends Error {
  constructor(message: string) {
    super(`users.yaml: ${message}`);
    this.name = 'UsersConfigError';
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UsersConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new UsersConfigError(`${field} must be a string when present`);
  }
  return value.trim() || null;
}

function asNumber(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new UsersConfigError(`${field} must be a number when present`);
  }
  return value;
}

function asBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new UsersConfigError(`${field} must be a boolean when present`);
  }
  return value;
}

function parseUser(raw: RawUser, defaultThreshold: number): User {
  const handle = asString(raw.handle, 'user.handle');
  if (!/^[a-z][a-z0-9-]*$/.test(handle)) {
    throw new UsersConfigError(
      `user.handle '${handle}' must match /^[a-z][a-z0-9-]*$/ (lowercase, digits, dashes; starts with a letter)`,
    );
  }
  return {
    handle,
    name: asString(raw.name, `user[${handle}].name`),
    emailTo: asString(raw.email_to, `user[${handle}].email_to`),
    vaultRemote: asString(raw.vault_remote, `user[${handle}].vault_remote`),
    vaultBranch: raw.vault_branch === undefined || raw.vault_branch === null
      ? 'main'
      : asString(raw.vault_branch, `user[${handle}].vault_branch`),
    interests: asString(raw.interests, `user[${handle}].interests`),
    threshold: asNumber(raw.threshold, `user[${handle}].threshold`, defaultThreshold),
    enabled: asBoolean(raw.enabled, `user[${handle}].enabled`, true),
    onboarded: asOptionalString(raw.onboarded, `user[${handle}].onboarded`),
  };
}

export function parseUsersConfig(text: string): UsersConfig {
  const raw = parseYaml(text) as RawConfig | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsersConfigError('top-level value must be a mapping');
  }
  const defaultThreshold = asNumber(raw.default_threshold, 'default_threshold', DEFAULT_THRESHOLD);
  if (!Array.isArray(raw.users)) {
    throw new UsersConfigError('users must be an array');
  }
  const seen = new Set<string>();
  const users: User[] = raw.users.map((u, i) => {
    if (!u || typeof u !== 'object') {
      throw new UsersConfigError(`users[${i}] must be a mapping`);
    }
    const parsed = parseUser(u as RawUser, defaultThreshold);
    if (seen.has(parsed.handle)) {
      throw new UsersConfigError(`duplicate user handle '${parsed.handle}'`);
    }
    seen.add(parsed.handle);
    return parsed;
  });
  return { defaultThreshold, users };
}

export function loadUsersConfig(path?: string): UsersConfig {
  const resolved = path ?? defaultUsersConfigPath();
  if (!existsSync(resolved)) {
    throw new UsersConfigError(`config file not found: ${resolved}`);
  }
  return parseUsersConfig(readFileSync(resolved, 'utf-8'));
}

/** Path resolution defaults to pipelines/config/users.yaml. */
export function defaultUsersConfigPath(): string {
  if (process.env.CHIYA_USERS_FILE) return resolve(process.env.CHIYA_USERS_FILE);
  // dist/shared/users.js lives at .../pipelines/dist/shared/, source at .../pipelines/src/shared/;
  // walk two levels up to land in pipelines/, then into config/users.yaml.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'config', 'users.yaml');
}

export function findEnabledUser(config: UsersConfig, handle: string): User {
  const user = config.users.find((u) => u.handle === handle);
  if (!user) {
    throw new UsersConfigError(`no user with handle '${handle}'`);
  }
  if (!user.enabled) {
    throw new UsersConfigError(`user '${handle}' is disabled`);
  }
  return user;
}

export function listEnabledUsers(config: UsersConfig): User[] {
  return config.users.filter((u) => u.enabled);
}

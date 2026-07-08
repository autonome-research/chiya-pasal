import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveTenantTargets } from '../src/shared/env.js';

const USERS_YAML = `
users:
  - handle: alice
    name: Alice
    email_to: alice@example.com
    vault_remote: git@github.com:x/vault-alice.git
    interests: interpretability of language models
  - handle: bob
    name: Bob
    email_to: bob@example.com
    vault_remote: git@github.com:x/vault-bob.git
    interests: protein design
    enabled: false
`;

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ['CHIYA_USERS_FILE', 'CHIYA_DATA_ROOT', 'CHIYA_EMAIL_TO', 'VAULT_DIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-tenants-'));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CHIYA_DATA_ROOT = join(dir, 'chiya-data');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveTenantTargets', () => {
  it('returns enabled users with per-user envs when users.yaml is present', () => {
    const usersFile = join(dir, 'users.yaml');
    writeFileSync(usersFile, USERS_YAML);
    process.env.CHIYA_USERS_FILE = usersFile;

    const targets = resolveTenantTargets();
    expect(targets.map((t) => t.handle)).toEqual(['alice']); // bob disabled
    const alice = targets[0]!.env;
    expect(alice.userHandle).toBe('alice');
    expect(alice.emailTo).toBe('alice@example.com');
    expect(alice.vaultDir).toBe(join(dir, 'chiya-data', 'users', 'alice', 'vault'));
    expect(alice.vaultRemote).toBe('git@github.com:x/vault-alice.git');
  });

  it('narrows to one user with onlyHandle, erroring on unknown or disabled', () => {
    const usersFile = join(dir, 'users.yaml');
    writeFileSync(usersFile, USERS_YAML);
    process.env.CHIYA_USERS_FILE = usersFile;

    const targets = resolveTenantTargets('alice');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.handle).toBe('alice');

    // A misspelled --user must fail loudly, not silently no-op.
    expect(() => resolveTenantTargets('mallory')).toThrow(/no user with handle/);
    expect(() => resolveTenantTargets('bob')).toThrow(/disabled/);
  });

  it('falls back to legacy single-tenant env when users.yaml is absent', () => {
    process.env.CHIYA_USERS_FILE = join(dir, 'does-not-exist.yaml');
    process.env.CHIYA_EMAIL_TO = 'legacy@example.com';
    process.env.VAULT_DIR = join(dir, 'legacy-vault');

    const targets = resolveTenantTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]!.handle).toBeNull();
    expect(targets[0]!.env.emailTo).toBe('legacy@example.com');
    expect(targets[0]!.env.vaultDir).toBe(join(dir, 'legacy-vault'));
  });
});

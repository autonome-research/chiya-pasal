import { describe, it, expect } from 'vitest';

import {
  parseUsersConfig,
  findEnabledUser,
  listEnabledUsers,
} from '../src/shared/users.js';

const VALID = `
default_threshold: 0.55

users:
  - handle: alice
    name: Alice Researcher
    email_to: alice@example.com
    vault_remote: git@github.com:autonome-research/vault-alice.git
    interests: |
      I research mechanistic interpretability of large language models —
      circuits, sparse autoencoders, what neurons compute.
    onboarded: 2026-06-28

  - handle: bob
    name: Bob
    email_to: bob@example.com
    vault_remote: git@github.com:autonome-research/vault-bob.git
    vault_branch: trunk
    interests: |
      Protein structure prediction and drug discovery.
    threshold: 0.65
    enabled: false
`;

describe('parseUsersConfig', () => {
  it('parses a valid config with defaults filled in', () => {
    const cfg = parseUsersConfig(VALID);
    expect(cfg.defaultThreshold).toBe(0.55);
    expect(cfg.users).toHaveLength(2);

    const alice = cfg.users[0]!;
    expect(alice.handle).toBe('alice');
    expect(alice.name).toBe('Alice Researcher');
    expect(alice.emailTo).toBe('alice@example.com');
    expect(alice.vaultBranch).toBe('main'); // default
    expect(alice.threshold).toBe(0.55);     // falls back to default
    expect(alice.enabled).toBe(true);        // default
    expect(alice.onboarded).toBe('2026-06-28');
    expect(alice.interests).toContain('mechanistic interpretability');

    const bob = cfg.users[1]!;
    expect(bob.vaultBranch).toBe('trunk');
    expect(bob.threshold).toBe(0.65);
    expect(bob.enabled).toBe(false);
    expect(bob.onboarded).toBeNull();
  });

  it('uses 0.5 as the default threshold when not specified', () => {
    const cfg = parseUsersConfig(`
users:
  - handle: a
    name: A
    email_to: a@x
    vault_remote: x
    interests: foo
`);
    expect(cfg.defaultThreshold).toBe(0.5);
  });

  it('rejects an invalid handle', () => {
    expect(() =>
      parseUsersConfig(`
users:
  - handle: "Bad-Handle"
    name: x
    email_to: a@x
    vault_remote: x
    interests: foo
`),
    ).toThrow(/handle.*must match/);
  });

  it('rejects a duplicate handle', () => {
    expect(() =>
      parseUsersConfig(`
users:
  - handle: alice
    name: A1
    email_to: a@x
    vault_remote: x
    interests: foo
  - handle: alice
    name: A2
    email_to: a@x
    vault_remote: x
    interests: foo
`),
    ).toThrow(/duplicate user handle/);
  });

  it('rejects missing required fields', () => {
    expect(() =>
      parseUsersConfig(`
users:
  - handle: alice
    name: A
    email_to: a@x
    vault_remote: x
`),
    ).toThrow(/interests.*non-empty/);
  });

  it('rejects when top level is not a mapping', () => {
    expect(() => parseUsersConfig('- not a mapping')).toThrow(/top-level value must be a mapping/);
  });

  it('rejects when users is not an array', () => {
    expect(() => parseUsersConfig('users: not an array')).toThrow(/users must be an array/);
  });
});

describe('findEnabledUser', () => {
  const cfg = parseUsersConfig(VALID);

  it('returns the user when handle matches and user is enabled', () => {
    const u = findEnabledUser(cfg, 'alice');
    expect(u.handle).toBe('alice');
  });

  it('throws for unknown handle', () => {
    expect(() => findEnabledUser(cfg, 'unknown')).toThrow(/no user with handle 'unknown'/);
  });

  it('throws for a disabled user', () => {
    expect(() => findEnabledUser(cfg, 'bob')).toThrow(/user 'bob' is disabled/);
  });
});

describe('listEnabledUsers', () => {
  it('filters out disabled users', () => {
    const cfg = parseUsersConfig(VALID);
    const enabled = listEnabledUsers(cfg);
    expect(enabled.map((u) => u.handle)).toEqual(['alice']);
  });
});

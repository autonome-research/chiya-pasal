import { describe, it, expect } from 'vitest';

import { addUser, removeUser, setUserEnabled, type NewUserInput } from '../src/shared/users-admin.js';
import { parseUsersConfig } from '../src/shared/users.js';

const ALICE: NewUserInput = {
  handle: 'alice',
  name: 'Alice Researcher',
  emailTo: 'alice@example.com',
  vaultRemote: 'git@github.com:autonome-research/vault-alice.git',
  interests: ['Mechanistic interpretability of language models.'],
  onboarded: '2026-07-01',
};

const EXISTING = `# fleet config — this comment must survive edits
default_threshold: 0.55

users:
  - handle: velvet
    name: Velvet
    email_to: v@example.com
    vault_remote: git@github.com:x/vault.git
    # velvet joined first
    interests: LLM ops and interpretability.
`;

describe('addUser', () => {
  it('appends a valid user to an existing config, preserving comments', () => {
    const out = addUser(EXISTING, ALICE);
    expect(out).toContain('# fleet config — this comment must survive edits');
    expect(out).toContain('# velvet joined first');

    const cfg = parseUsersConfig(out);
    expect(cfg.users.map((u) => u.handle)).toEqual(['velvet', 'alice']);
    const alice = cfg.users[1]!;
    expect(alice.emailTo).toBe('alice@example.com');
    expect(alice.threshold).toBe(0.55); // inherits file default
    expect(alice.onboarded).toBe('2026-07-01');
    expect(alice.enabled).toBe(true);
  });

  it('bootstraps a fresh file from empty input', () => {
    const out = addUser('', ALICE);
    const cfg = parseUsersConfig(out);
    expect(cfg.users.map((u) => u.handle)).toEqual(['alice']);
  });

  it('records optional branch and threshold when given', () => {
    const out = addUser('', { ...ALICE, vaultBranch: 'trunk', threshold: 0.62 });
    const alice = parseUsersConfig(out).users[0]!;
    expect(alice.vaultBranch).toBe('trunk');
    expect(alice.threshold).toBe(0.62);
  });

  it('rejects a duplicate handle', () => {
    const out = addUser(EXISTING, ALICE);
    expect(() => addUser(out, ALICE)).toThrow(/already exists/);
  });

  it('refuses to write a config the loader would reject (bad handle)', () => {
    expect(() => addUser('', { ...ALICE, handle: 'Bad Handle!' })).toThrow(/must match/);
  });
});

describe('setUserEnabled', () => {
  it('pauses and resumes a user in place', () => {
    const paused = setUserEnabled(EXISTING, 'velvet', false);
    expect(parseUsersConfig(paused).users[0]!.enabled).toBe(false);
    const resumed = setUserEnabled(paused, 'velvet', true);
    expect(parseUsersConfig(resumed).users[0]!.enabled).toBe(true);
    expect(resumed).toContain('# velvet joined first'); // comments intact
  });

  it('throws on unknown handle', () => {
    expect(() => setUserEnabled(EXISTING, 'mallory', false)).toThrow(/no user with handle/);
  });
});

describe('removeUser', () => {
  it('removes the user and leaves the rest of the file intact', () => {
    const withAlice = addUser(EXISTING, ALICE);
    const out = removeUser(withAlice, 'velvet');
    const cfg = parseUsersConfig(out);
    expect(cfg.users.map((u) => u.handle)).toEqual(['alice']);
    expect(out).toContain('# fleet config — this comment must survive edits');
  });

  it('throws on unknown handle', () => {
    expect(() => removeUser(EXISTING, 'mallory')).toThrow(/no user with handle/);
  });
});

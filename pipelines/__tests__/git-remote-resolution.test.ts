import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitOps } from '../src/tools/git.js';

/**
 * users.yaml stores vault_remote as a URL; GitOps must resolve it to the
 * repo's configured remote name before fetch/push. This bit production:
 * `git fetch git@github.com:.../vault.git main` treats the URL as a remote
 * name and fails with "invalid object name".
 */

let root: string;
let bareDir: string;
let workDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'chiya-gitops-'));
  bareDir = join(root, 'remote.git');
  workDir = join(root, 'vault');
  git(root, 'init', '--bare', '-b', 'main', bareDir);
  git(root, 'clone', bareDir, workDir);
  git(workDir, 'config', 'user.email', 'test@example.com');
  git(workDir, 'config', 'user.name', 'test');
  git(workDir, 'commit', '--allow-empty', '-m', 'initial');
  git(workDir, 'push', 'origin', 'main');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitOps remote resolution', () => {
  it('accepts a configured remote name as-is', async () => {
    const ops = new GitOps({ vaultDir: workDir, remote: 'origin', branch: 'main' });
    await expect(ops.unpushedCount()).resolves.toBe(0);
  });

  it('resolves a remote URL to the matching remote name', async () => {
    const ops = new GitOps({ vaultDir: workDir, remote: bareDir, branch: 'main' });
    await expect(ops.unpushedCount()).resolves.toBe(0);
    await expect(ops.fetch()).resolves.toBeUndefined();
  });

  it('resolves URLs that differ only by a trailing .git', async () => {
    // Configured URL ends in .git (the bare dir); config value without it.
    const ops = new GitOps({
      vaultDir: workDir,
      remote: bareDir.replace(/\.git$/, ''),
      branch: 'main',
    });
    await expect(ops.unpushedCount()).resolves.toBe(0);
  });

  it('throws loudly for a remote that matches nothing', async () => {
    const ops = new GitOps({
      vaultDir: workDir,
      remote: 'git@github.com:nobody/nowhere.git',
      branch: 'main',
    });
    await expect(ops.unpushedCount()).rejects.toThrow(/neither a configured remote name/);
  });
});

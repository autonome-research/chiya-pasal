/**
 * Git operations on the vault repo. All operations run with cwd = vaultDir.
 *
 * Strategy (per design):
 *   - librarian.commit():  local commit only, no push.
 *   - digest.squashAndPush(): fetch, squash all unpushed commits, push.
 *
 * Result: many small local commits accumulate; remote sees one squashed
 * commit per digest run.
 */

import { spawn } from 'child_process';

export interface GitOpsOptions {
  vaultDir: string;
  /**
   * Git remote NAME (`origin`) or URL (`git@github.com:me/vault.git`).
   * users.yaml stores vault_remote as a URL, so URLs are resolved to the
   * repo's matching configured remote name before any fetch/push.
   */
  remote: string;
  branch: string;
}

export class GitOps {
  private resolvedRemote?: string;

  constructor(private readonly opts: GitOpsOptions) {}

  /**
   * Resolve opts.remote to a configured remote name (memoized). A value that
   * matches a remote name is used as-is; a URL is matched against each
   * remote's fetch URL (ignoring a trailing `.git`). Anything else throws —
   * a misconfigured remote must fail loudly, not push somewhere surprising.
   */
  private async remoteName(): Promise<string> {
    if (this.resolvedRemote) return this.resolvedRemote;
    const names = (await this.run(['remote']))
      .stdout.split('\n').map((n) => n.trim()).filter(Boolean);
    const target = this.opts.remote;
    if (names.includes(target)) {
      this.resolvedRemote = target;
      return target;
    }
    const strip = (u: string) => u.replace(/\.git$/, '');
    for (const name of names) {
      const url = (await this.run(['remote', 'get-url', name])).stdout.trim();
      if (strip(url) === strip(target)) {
        this.resolvedRemote = name;
        return name;
      }
    }
    throw new Error(
      `vault remote '${target}' is neither a configured remote name nor the ` +
        `URL of one (configured: ${names.join(', ') || 'none'}) in ${this.opts.vaultDir}`,
    );
  }

  /** Returns true iff there are uncommitted changes (staged or working). */
  async hasChanges(): Promise<boolean> {
    const out = await this.run(['status', '--porcelain']);
    return out.stdout.trim().length > 0;
  }

  /**
   * Stage explicit pathspecs and commit. No-op (returns false) if nothing to
   * commit after staging.
   *
   * Pathspecs are passed verbatim to `git add`, so they support globs (e.g.
   * `wiki/`, `log.md`, `index.md`) but won't sweep the working tree the way
   * `git add -A` does. This keeps unrelated working-tree changes (sqlite WAL
   * files, freshly-collected matcha output, etc.) out of pipeline commits.
   */
  async commit(
    message: string,
    pathspecs: string[],
  ): Promise<{ committed: boolean; sha?: string }> {
    if (pathspecs.length === 0) return { committed: false };
    await this.run(['add', '--', ...pathspecs]);
    // After explicit add, check if anything actually got staged.
    const staged = await this.run(['diff', '--cached', '--name-only']);
    if (staged.stdout.trim().length === 0) {
      return { committed: false };
    }
    await this.run(['commit', '-m', message]);
    const sha = (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
    return { committed: true, sha };
  }

  /** git fetch <remote> <branch> — refresh remote tracking. */
  async fetch(): Promise<void> {
    await this.run(['fetch', await this.remoteName(), this.opts.branch]);
  }

  /** Number of local commits ahead of <remote>/<branch>. */
  async unpushedCount(): Promise<number> {
    const out = await this.run([
      'rev-list',
      '--count',
      `${await this.remoteName()}/${this.opts.branch}..HEAD`,
    ]);
    return parseInt(out.stdout.trim(), 10) || 0;
  }

  /**
   * Squash all unpushed commits into one, then push.
   *
   * - fetch first to make sure we know the true remote tip
   * - if 0 unpushed: no-op (nothing to push)
   * - if 1 unpushed: just push (no squash needed)
   * - if >1 unpushed: verify remote tip is an ancestor of HEAD, reset --soft
   *   to it, single commit with the given message, then push
   *
   * The ancestry check matters: if HEAD has diverged from remote (e.g. remote
   * moved forward independently and we never merged), `git reset --soft
   * <remote>` followed by recommit would silently revert remote-only changes
   * — the soft reset moves HEAD to remote/branch but keeps the working tree
   * at the old HEAD's content, so re-committing produces a tree that's
   * missing whatever remote added. Bail out instead and let the caller
   * surface the error.
   */
  async squashAndPush(messageBuilder: (count: number) => string): Promise<{
    pushed: boolean;
    squashedCount: number;
    sha?: string;
  }> {
    await this.fetch();
    const count = await this.unpushedCount();
    if (count === 0) return { pushed: false, squashedCount: 0 };

    if (count > 1) {
      const remoteRef = `${await this.remoteName()}/${this.opts.branch}`;
      try {
        await this.run(['merge-base', '--is-ancestor', remoteRef, 'HEAD']);
      } catch {
        throw new Error(
          `squashAndPush: ${remoteRef} is not an ancestor of HEAD — refusing to ` +
            `soft-reset, since it would revert remote-only changes. Resolve the ` +
            `divergence manually (rebase or merge) before re-running.`,
        );
      }
      await this.run(['reset', '--soft', remoteRef]);
      await this.run(['commit', '-m', messageBuilder(count)]);
    }
    await this.run(['push', await this.remoteName(), this.opts.branch]);
    const sha = (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
    return { pushed: true, squashedCount: count, sha };
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd: this.opts.vaultDir });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }
}

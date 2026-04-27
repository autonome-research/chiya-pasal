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
  remote: string;
  branch: string;
}

export class GitOps {
  constructor(private readonly opts: GitOpsOptions) {}

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
    await this.run(['fetch', this.opts.remote, this.opts.branch]);
  }

  /** Number of local commits ahead of <remote>/<branch>. */
  async unpushedCount(): Promise<number> {
    const out = await this.run([
      'rev-list',
      '--count',
      `${this.opts.remote}/${this.opts.branch}..HEAD`,
    ]);
    return parseInt(out.stdout.trim(), 10) || 0;
  }

  /**
   * Squash all unpushed commits into one, then push.
   *
   * - fetch first to make sure we know the true remote tip
   * - if 0 unpushed: no-op (nothing to push)
   * - if 1 unpushed: just push (no squash needed)
   * - if >1 unpushed: reset --soft to the remote tip, single commit with the
   *   given message, then push
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
      const remoteRef = `${this.opts.remote}/${this.opts.branch}`;
      await this.run(['reset', '--soft', remoteRef]);
      await this.run(['commit', '-m', messageBuilder(count)]);
    }
    await this.run(['push', this.opts.remote, this.opts.branch]);
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

/**
 * Cross-process vault mutation lock.
 *
 * Librarian and digest are separate systemd services. Even with the librarian's
 * per-batch serial apply, the two services can still race on log.md and git
 * operations. This lock uses an atomic mkdir under the vault root so all local
 * Node processes agree on one mutation section without a native flock dep.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import type { BasePipelineContext, Phase, PipelineEvent } from 'thread-phase';

export interface VaultMutationLockOptions {
  /** Vault repo root. The lock directory is created directly under this path. */
  vaultDir: string;
  /** Directory basename used for the lock. */
  name?: string;
  /** Remove a leftover lock older than this many minutes. */
  staleMinutes?: number;
  /** Poll interval while another process holds a non-stale lock. */
  pollMs?: number;
}

export interface VaultMutationLockRelease {
  id: string;
  path: string;
  release(): Promise<void>;
}

const DEFAULT_NAME = '.chiya-vault-mutation.lock';
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_POLL_MS = 1000;

export class VaultMutationLock {
  readonly lockPath: string;
  private readonly staleMs: number;
  private readonly pollMs: number;

  constructor(private readonly opts: VaultMutationLockOptions) {
    this.lockPath = join(opts.vaultDir, opts.name ?? DEFAULT_NAME);
    this.staleMs = (opts.staleMinutes ?? DEFAULT_STALE_MINUTES) * 60 * 1000;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  async acquire(signal?: AbortSignal): Promise<VaultMutationLockRelease> {
    const id = `${process.pid}-${Date.now()}-${randomUUID()}`;
    while (true) {
      if (signal?.aborted) throw abortError(signal.reason);
      try {
        await fs.mkdir(this.lockPath);
        await fs.writeFile(
          join(this.lockPath, 'owner.json'),
          JSON.stringify({ id, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2),
          'utf8',
        );
        return {
          id,
          path: this.lockPath,
          release: async () => {
            await this.release(id);
          },
        };
      } catch (err) {
        const e = err as { code?: string };
        if (e.code !== 'EEXIST') throw err;
        if (await this.removeIfStale()) continue;
        await wait(this.pollMs, signal);
      }
    }
  }

  private async removeIfStale(): Promise<boolean> {
    let stat;
    try {
      stat = await fs.stat(this.lockPath);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') return true;
      throw err;
    }
    if (Date.now() - stat.mtimeMs <= this.staleMs) return false;
    await fs.rm(this.lockPath, { recursive: true, force: true });
    return true;
  }

  private async release(id: string): Promise<void> {
    try {
      const raw = await fs.readFile(join(this.lockPath, 'owner.json'), 'utf8');
      const owner = JSON.parse(raw) as { id?: string };
      if (owner.id !== id) return; // stale owner superseded by another process
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') return;
      // If owner.json is corrupt/missing inside an existing dir, still try to
      // remove the lock we hold; mkdir acquisition always writes owner.json.
    }
    await fs.rm(this.lockPath, { recursive: true, force: true });
  }
}

function abortError(reason: unknown): Error {
  const err = new Error(`vault mutation lock aborted${reason ? `: ${String(reason)}` : ''}`);
  err.name = 'AbortError';
  return err;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw abortError(signal?.reason);
    throw err;
  }
}

function signalFromCtx(ctx: BasePipelineContext): AbortSignal | undefined {
  const maybe = (ctx as { signal?: unknown }).signal;
  return maybe instanceof AbortSignal ? maybe : undefined;
}

/**
 * Wrap a set of side-effecting phases so only one local pipeline mutates the
 * vault/git working tree at a time. Events from inner phases are yielded as-is.
 */
export function withVaultMutationLock<TCtx extends BasePipelineContext>(
  lock: VaultMutationLock,
  phases: ReadonlyArray<Phase<TCtx>>,
  name = 'vault-mutation-section',
): Phase<TCtx> {
  return {
    name,
    async *run(ctx: TCtx): AsyncGenerator<PipelineEvent, void> {
      yield { type: 'phase', phase: name, detail: 'waiting for vault mutation lock' };
      const lease = await lock.acquire(signalFromCtx(ctx));
      yield { type: 'phase', phase: name, detail: `acquired ${lease.id}` };
      try {
        for (const phase of phases) {
          if (ctx.stop) break;
          for await (const ev of phase.run(ctx)) {
            yield ev;
          }
        }
      } finally {
        await lease.release();
        yield { type: 'phase', phase: name, detail: 'released vault mutation lock' };
      }
    },
  };
}

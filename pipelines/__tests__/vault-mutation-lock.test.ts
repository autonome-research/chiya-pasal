import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { VaultMutationLock } from '../src/shared/vault-mutation-lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('VaultMutationLock', () => {
  it('serializes concurrent acquirers', async () => {
    const lock = new VaultMutationLock({ vaultDir: dir, pollMs: 5, staleMinutes: 5 });
    const first = await lock.acquire();
    let secondAcquired = false;

    const secondPromise = lock.acquire().then(async (lease) => {
      secondAcquired = true;
      await lease.release();
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);

    await first.release();
    await secondPromise;
    expect(secondAcquired).toBe(true);
  });

  it('removes stale lock directories', async () => {
    const lockDir = join(dir, '.chiya-vault-mutation.lock');
    await fs.mkdir(lockDir);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);

    const lock = new VaultMutationLock({ vaultDir: dir, pollMs: 5, staleMinutes: 0.001 });
    const lease = await lock.acquire();
    expect(lease.path).toBe(lockDir);
    await lease.release();
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

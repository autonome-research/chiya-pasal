import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolRegistry } from 'thread-phase';

import { VaultFs, registerVaultToolsTracked } from '../src/tools/vault.js';

let dir: string;
let vault: VaultFs;
let registry: ToolRegistry;
let tracker: ReturnType<typeof registerVaultToolsTracked>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-vt-'));
  vault = new VaultFs(dir);
  registry = new ToolRegistry();
  tracker = registerVaultToolsTracked(registry, vault);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function execWrite(path: string, content: string): Promise<void> {
  await registry.execute('vault_write', 'tc-' + Math.random(), { path, content });
}

describe('vault tracker — rollback restores pre-write state', () => {
  it('unlinks newly-created files', async () => {
    await execWrite('wiki/topics/new.md', '# new content');
    expect(existsSync(join(dir, 'wiki/topics/new.md'))).toBe(true);
    const result = await tracker.rollback();
    expect(result.deleted).toEqual(['wiki/topics/new.md']);
    expect(result.restored).toEqual([]);
    expect(existsSync(join(dir, 'wiki/topics/new.md'))).toBe(false);
  });

  it('restores pre-existing files to their original content', async () => {
    mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
    writeFileSync(join(dir, 'wiki/topics/existing.md'), '# original');
    await execWrite('wiki/topics/existing.md', '# overwritten');
    expect(readFileSync(join(dir, 'wiki/topics/existing.md'), 'utf-8')).toBe('# overwritten');

    const result = await tracker.rollback();
    expect(result.restored).toEqual(['wiki/topics/existing.md']);
    expect(result.deleted).toEqual([]);
    expect(readFileSync(join(dir, 'wiki/topics/existing.md'), 'utf-8')).toBe('# original');
  });

  it('snapshots only the FIRST write per path, so multiple writes still rollback to original', async () => {
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'wiki/page.md'), 'v0');

    await execWrite('wiki/page.md', 'v1');
    await execWrite('wiki/page.md', 'v2');
    await execWrite('wiki/page.md', 'v3');
    expect(readFileSync(join(dir, 'wiki/page.md'), 'utf-8')).toBe('v3');

    await tracker.rollback();
    expect(readFileSync(join(dir, 'wiki/page.md'), 'utf-8')).toBe('v0');
  });

  it('handles a mix of new and existing pages in one rollback', async () => {
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'wiki/old.md'), 'old-orig');

    await execWrite('wiki/old.md', 'old-modified');
    await execWrite('wiki/new.md', 'new-content');

    const result = await tracker.rollback();
    expect(result.restored.sort()).toEqual(['wiki/old.md']);
    expect(result.deleted.sort()).toEqual(['wiki/new.md']);
    expect(readFileSync(join(dir, 'wiki/old.md'), 'utf-8')).toBe('old-orig');
    expect(existsSync(join(dir, 'wiki/new.md'))).toBe(false);
  });

  it('skips rollback for a path whose contents have been changed by another writer (concurrent-write guard)', async () => {
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'wiki/shared.md'), 'orig');

    await execWrite('wiki/shared.md', 'tracker-wrote');
    // Simulate another concurrent runner overwriting after our write.
    writeFileSync(join(dir, 'wiki/shared.md'), 'someone-else');

    const result = await tracker.rollback();
    expect(result.superseded).toEqual(['wiki/shared.md']);
    expect(result.restored).toEqual([]);
    expect(result.deleted).toEqual([]);
    // The other writer's content is preserved — we don't clobber it.
    expect(readFileSync(join(dir, 'wiki/shared.md'), 'utf-8')).toBe('someone-else');
  });

  it('rollback on a tracker that never saw a write is a no-op', async () => {
    const result = await tracker.rollback();
    expect(result).toEqual({ restored: [], deleted: [], superseded: [] });
  });
});

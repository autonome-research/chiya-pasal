/**
 * Vault filesystem helpers — scoped to $VAULT_DIR with path-traversal guard.
 *
 * Two surfaces from the same impl:
 *   1. Direct TS functions used by pure-code phases (loadContext, appendLog).
 *   2. ToolDefinition + handler builder (registerVaultTools) so an LLM phase
 *      can invoke vault.read / vault.write / vault.list as registered tools.
 */

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path';
import { glob } from 'glob';
import type { ToolRegistry } from 'thread-phase';

export class VaultFs {
  constructor(private readonly root: string) {}

  /** Resolve a relative vault path; throws if it would escape the root. */
  private resolveSafe(path: string): string {
    if (isAbsolute(path)) {
      throw new Error(`vault path must be relative, got absolute: ${path}`);
    }
    const abs = resolve(this.root, normalize(path));
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`vault path escapes root: ${path}`);
    }
    return abs;
  }

  async read(path: string): Promise<string> {
    return fs.readFile(this.resolveSafe(path), 'utf8');
  }

  async readOptional(path: string): Promise<string | null> {
    try {
      return await this.read(path);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Read the last N lines of a file. */
  async readTail(path: string, lines: number): Promise<string> {
    const content = await this.read(path);
    return content.split('\n').slice(-lines).join('\n');
  }

  async write(path: string, content: string): Promise<void> {
    const abs = this.resolveSafe(path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async append(path: string, content: string): Promise<void> {
    const abs = this.resolveSafe(path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.stat(this.resolveSafe(path));
      return true;
    } catch {
      return false;
    }
  }

  async unlink(path: string): Promise<void> {
    await fs.unlink(this.resolveSafe(path));
  }

  /** Glob within the vault. Returns vault-relative paths. */
  async list(pattern: string): Promise<string[]> {
    const matches = await glob(pattern, { cwd: this.root, nodir: true });
    return matches.sort();
  }

  /** List + read all files matching glob. Useful for focuses/, STATUS.md families. */
  async listAndRead(pattern: string): Promise<Array<{ path: string; content: string }>> {
    const paths = await this.list(pattern);
    const out: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      out.push({ path, content: await this.read(path) });
    }
    return out;
  }

  /**
   * Grep-style search across files matching `pattern` (glob). For each line
   * containing `keyword` (case-insensitive substring), return one match.
   * Caps total matches at `limit` so an agent's tool call doesn't dump the
   * whole vault on a popular keyword.
   *
   * Used by the v3 librarian's scouts to discover candidate pages by keyword
   * before deciding which to vault_read in full.
   */
  async searchByKeyword(
    pattern: string,
    keyword: string,
    limit: number = 50,
  ): Promise<Array<{ path: string; line: number; context: string }>> {
    const needle = keyword.toLowerCase();
    if (needle.length === 0) return [];
    const paths = await this.list(pattern);
    const out: Array<{ path: string; line: number; context: string }> = [];
    for (const p of paths) {
      const text = await this.read(p);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          out.push({ path: p, line: i + 1, context: lines[i]!.slice(0, 200) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  get rootDir(): string {
    return this.root;
  }
}

// ---------------------------------------------------------------------------
// LLM-callable surface — register vault read/write/list as tools so an agent
// in a phase can invoke them via runAgentWithTools + ToolRegistry.
// ---------------------------------------------------------------------------

export function registerVaultTools(registry: ToolRegistry, vault: VaultFs): void {
  registry.register(
    {
      name: 'vault_read',
      description: 'Read a file from the vault. Path is relative to the vault root.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => {
      const content = await vault.readOptional(String(path));
      return content ?? `[NOT FOUND: ${path}]`;
    },
  );

  registry.register(
    {
      name: 'vault_write',
      description:
        'Write (or overwrite) a file in the vault. Creates parent directories as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    async ({ path, content }) => {
      await vault.write(String(path), String(content));
      return `wrote ${path} (${String(content).length} chars)`;
    },
  );

  registry.register(
    {
      name: 'vault_list',
      description: 'List vault files matching a glob pattern. Returns one path per line.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
    async ({ pattern }) => {
      const paths = await vault.list(String(pattern));
      return paths.length ? paths.join('\n') : '(no matches)';
    },
  );

  registry.register(
    {
      name: 'vault_exists',
      description: 'Check if a vault path exists. Returns "true" or "false".',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => String(await vault.exists(String(path))),
  );

  registry.register(
    {
      name: 'vault_search_by_keyword',
      description:
        'Grep for `keyword` (case-insensitive substring) across vault files matching `pattern`. ' +
        'Returns up to 50 matches in `path:line: context` form, one per line. ' +
        'Use to discover candidate pages for a topic before deciding which to vault_read in full.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob, e.g. "wiki/topics/**/*.md"' },
          keyword: { type: 'string' },
        },
        required: ['pattern', 'keyword'],
      },
    },
    async ({ pattern, keyword }) => {
      const hits = await vault.searchByKeyword(String(pattern), String(keyword));
      if (hits.length === 0) return '(no matches)';
      return hits.map((h) => `${h.path}:${h.line}: ${h.context}`).join('\n');
    },
  );
}

// ---------------------------------------------------------------------------
// Read-only subset — used by the v3 librarian's exploration scouts (topic /
// source / entity / cite). They surface candidate pages for the reviewer; they
// must not mutate the vault. Keep these registrations in lockstep with the
// read tools in registerVaultTools above.
// ---------------------------------------------------------------------------

export function registerReadOnlyVaultTools(registry: ToolRegistry, vault: VaultFs): void {
  registry.register(
    {
      name: 'vault_read',
      description: 'Read a file from the vault. Path is relative to the vault root.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => {
      const content = await vault.readOptional(String(path));
      return content ?? `[NOT FOUND: ${path}]`;
    },
  );

  registry.register(
    {
      name: 'vault_list',
      description: 'List vault files matching a glob pattern. Returns one path per line.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
    async ({ pattern }) => {
      const paths = await vault.list(String(pattern));
      return paths.length ? paths.join('\n') : '(no matches)';
    },
  );

  registry.register(
    {
      name: 'vault_exists',
      description: 'Check if a vault path exists. Returns "true" or "false".',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => String(await vault.exists(String(path))),
  );

  registry.register(
    {
      name: 'vault_search_by_keyword',
      description:
        'Grep for `keyword` (case-insensitive substring) across vault files matching `pattern`. ' +
        'Returns up to 50 matches in `path:line: context` form, one per line. ' +
        'Use to discover candidate pages for a topic before deciding which to vault_read in full.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob, e.g. "wiki/topics/**/*.md"' },
          keyword: { type: 'string' },
        },
        required: ['pattern', 'keyword'],
      },
    },
    async ({ pattern, keyword }) => {
      const hits = await vault.searchByKeyword(String(pattern), String(keyword));
      if (hits.length === 0) return '(no matches)';
      return hits.map((h) => `${h.path}:${h.line}: ${h.context}`).join('\n');
    },
  );
}

// ---------------------------------------------------------------------------
// Tracked variant — same surface, but vault_write captures pre-write state
// per path so the caller can roll back partial writes if a post-call check
// (URL-citation, ghost-paths, truncation) fails.
//
// Per-article use: build one tracker per upsert call (the registry is
// already per-article in librarian-phases.ts processBatch), call
// tracker.rollback() on validation failure, drop the tracker on success.
// ---------------------------------------------------------------------------

export interface WriteTracker {
  /**
   * Restore every page this article wrote to its pre-write state. New pages
   * (no prior content) are unlinked. Concurrent-write guard: if the page's
   * current contents differ from what we last wrote (i.e. another
   * concurrent runner has touched it since), skip the rollback for that
   * path — the other writer's work supersedes ours.
   */
  rollback(): Promise<{ restored: string[]; deleted: string[]; superseded: string[] }>;
}

interface WriteRecord {
  before: string | null; // null = file did not exist before this article touched it
  lastWrote: string; // what we most recently wrote, for the concurrent-write guard
}

export function registerVaultToolsTracked(
  registry: ToolRegistry,
  vault: VaultFs,
): WriteTracker {
  const writes = new Map<string, WriteRecord>();

  // Read-side tools are unchanged.
  registry.register(
    {
      name: 'vault_read',
      description: 'Read a file from the vault. Path is relative to the vault root.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => {
      const content = await vault.readOptional(String(path));
      return content ?? `[NOT FOUND: ${path}]`;
    },
  );

  registry.register(
    {
      name: 'vault_write',
      description:
        'Write (or overwrite) a file in the vault. Creates parent directories as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    async ({ path, content }) => {
      const p = String(path);
      const c = String(content);
      // Snapshot before-state ONCE per path. Subsequent writes by the same
      // agent update lastWrote but leave `before` at the original pre-runner
      // state, so rollback unwinds the article's full effect on this path.
      if (!writes.has(p)) {
        const existed = await vault.exists(p);
        writes.set(p, { before: existed ? await vault.read(p) : null, lastWrote: c });
      } else {
        writes.get(p)!.lastWrote = c;
      }
      await vault.write(p, c);
      return `wrote ${p} (${c.length} chars)`;
    },
  );

  registry.register(
    {
      name: 'vault_list',
      description: 'List vault files matching a glob pattern. Returns one path per line.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
    async ({ pattern }) => {
      const paths = await vault.list(String(pattern));
      return paths.length ? paths.join('\n') : '(no matches)';
    },
  );

  registry.register(
    {
      name: 'vault_exists',
      description: 'Check if a vault path exists. Returns "true" or "false".',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async ({ path }) => String(await vault.exists(String(path))),
  );

  registry.register(
    {
      name: 'vault_search_by_keyword',
      description:
        'Grep for `keyword` (case-insensitive substring) across vault files matching `pattern`. ' +
        'Returns up to 50 matches in `path:line: context` form, one per line.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          keyword: { type: 'string' },
        },
        required: ['pattern', 'keyword'],
      },
    },
    async ({ pattern, keyword }) => {
      const hits = await vault.searchByKeyword(String(pattern), String(keyword));
      if (hits.length === 0) return '(no matches)';
      return hits.map((h) => `${h.path}:${h.line}: ${h.context}`).join('\n');
    },
  );

  return {
    async rollback() {
      const restored: string[] = [];
      const deleted: string[] = [];
      const superseded: string[] = [];
      for (const [path, { before, lastWrote }] of writes) {
        const exists = await vault.exists(path);
        const current = exists ? await vault.read(path) : null;
        if (current !== lastWrote) {
          // Someone else has touched this path since we wrote it; their
          // version supersedes our about-to-be-rolled-back state.
          superseded.push(path);
          continue;
        }
        if (before === null) {
          await vault.unlink(path);
          deleted.push(path);
        } else {
          await vault.write(path, before);
          restored.push(path);
        }
      }
      return { restored, deleted, superseded };
    },
  };
}

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
}

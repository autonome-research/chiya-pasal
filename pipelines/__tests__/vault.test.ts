import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolRegistry } from 'thread-phase';

import { VaultFs, registerVaultTools } from '../src/tools/vault.js';

let dir: string;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-vault-'));
  vault = new VaultFs(dir);
  mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
  mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('VaultFs.searchByKeyword', () => {
  it('returns path/line/context for keyword hits across glob', async () => {
    writeFileSync(join(dir, 'wiki/topics/llm-tool-use.md'), '# LLM tool use\n\nAgents that call tools.\nAlso related to MCP.\n');
    writeFileSync(join(dir, 'wiki/topics/agent-commerce.md'), '# Agent commerce\n\nMarketplaces for agents.\n');
    const hits = await vault.searchByKeyword('wiki/topics/**/*.md', 'agent');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const summary = hits.map((h) => `${h.path}:${h.line}`);
    expect(summary).toContain('wiki/topics/llm-tool-use.md:3');
    expect(summary).toContain('wiki/topics/agent-commerce.md:1');
  });

  it('case-insensitive', async () => {
    writeFileSync(join(dir, 'wiki/topics/p.md'), 'Quantum stuff and QUANTUM more.\nNo q here.\n');
    const hits = await vault.searchByKeyword('wiki/topics/**/*.md', 'quantum');
    expect(hits).toHaveLength(1); // line 1 contains both occurrences but is reported once
    expect(hits[0]!.line).toBe(1);
  });

  it('caps at limit', async () => {
    const lines = Array.from({ length: 200 }, () => 'foo bar').join('\n');
    writeFileSync(join(dir, 'wiki/topics/big.md'), lines);
    const hits = await vault.searchByKeyword('wiki/topics/**/*.md', 'foo', 10);
    expect(hits).toHaveLength(10);
  });

  it('returns empty for empty keyword', async () => {
    writeFileSync(join(dir, 'wiki/topics/p.md'), 'anything');
    expect(await vault.searchByKeyword('wiki/topics/**/*.md', '')).toEqual([]);
  });

  it('returns empty when no files match the glob', async () => {
    expect(await vault.searchByKeyword('wiki/no-such-dir/*.md', 'x')).toEqual([]);
  });

  it('truncates context lines longer than 200 chars', async () => {
    const longLine = 'x'.repeat(500) + ' KEYWORD ' + 'y'.repeat(500);
    writeFileSync(join(dir, 'wiki/topics/p.md'), longLine);
    const hits = await vault.searchByKeyword('wiki/topics/**/*.md', 'keyword');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.context.length).toBeLessThanOrEqual(200);
  });
});

describe('vault_search_by_keyword tool registration', () => {
  it('returns formatted results via the tool surface', async () => {
    writeFileSync(join(dir, 'wiki/topics/foo.md'), '# Foo\nBar baz quux\n');
    const reg = new ToolRegistry();
    registerVaultTools(reg, vault);
    const result = await reg.execute('vault_search_by_keyword', 't1', {
      pattern: 'wiki/topics/**/*.md',
      keyword: 'baz',
    });
    expect(result.content).toContain('wiki/topics/foo.md:2');
    expect(result.content).toContain('Bar baz quux');
  });

  it('returns "(no matches)" when nothing hits', async () => {
    const reg = new ToolRegistry();
    registerVaultTools(reg, vault);
    const result = await reg.execute('vault_search_by_keyword', 't1', {
      pattern: 'wiki/topics/**/*.md',
      keyword: 'never-occurs',
    });
    expect(result.content).toBe('(no matches)');
  });
});

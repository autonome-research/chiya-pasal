import { promises as fs } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadContext, loadTopicSlugs } from '../src/phases/digest/context.js';
import { buildClassifierSystemPrompt } from '../src/phases/digest/classify.js';
import type { DigestCtx, VaultContext } from '../src/shared/digest-types.js';
import { VaultFs } from '../src/tools/vault.js';

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function ctx(): DigestCtx {
  return {
    cache: new PipelineCache(),
    direction: 'AM',
    date: '2026-08-02',
    signal: new AbortController().signal,
  };
}

function vaultContext(overrides: Partial<VaultContext> = {}): VaultContext {
  return {
    claudeMd: '',
    tasteMd: '',
    logTail: '',
    focuses: [],
    research: [],
    profile: null,
    interests: null,
    interestParagraphs: [],
    topicSlugs: [],
    ...overrides,
  };
}

describe('digest context loading', () => {
  let dir: string;
  let vault: VaultFs;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chiya-digest-ctx-'));
    vault = new VaultFs(dir);
    // Minimum files loadContext requires.
    await vault.write('CLAUDE.md', '# vault');
    await vault.write('wiki/TASTE.md', '');
    await vault.write('log.md', 'entry\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('threads tenant interests into the vault context, trimming empties', async () => {
    const c = ctx();
    await drain(
      loadContext(vault, ['  mech interp for tiny models  ', '', 'GB10 kernels']).run(c),
    );
    expect(c.vault?.interestParagraphs).toEqual(['mech interp for tiny models', 'GB10 kernels']);
  });

  it('defaults tenant interests to empty when absent (single-tenant/null)', async () => {
    const c = ctx();
    await drain(loadContext(vault, null).run(c));
    expect(c.vault?.interestParagraphs).toEqual([]);

    const c2 = ctx();
    await drain(loadContext(vault).run(c2));
    expect(c2.vault?.interestParagraphs).toEqual([]);
  });

  it('tolerates a missing wiki/topics dir', async () => {
    const c = ctx();
    await drain(loadContext(vault).run(c));
    expect(c.vault?.topicSlugs).toEqual([]);
  });

  it('builds the topic inventory from flat wiki/topics/*.md basenames', async () => {
    await vault.write('wiki/topics/sparse-autoencoders.md', 'x');
    await vault.write('wiki/topics/slam.md', 'x');
    const c = ctx();
    await drain(loadContext(vault).run(c));
    expect([...(c.vault?.topicSlugs ?? [])].sort()).toEqual(['slam', 'sparse-autoencoders']);
  });
});

describe('loadTopicSlugs caps', () => {
  let dir: string;
  let vault: VaultFs;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chiya-topic-slugs-'));
    vault = new VaultFs(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeTopic(slug: string, mtime: Date): Promise<void> {
    await vault.write(`wiki/topics/${slug}.md`, 'x');
    await fs.utimes(join(dir, 'wiki/topics', `${slug}.md`), mtime, mtime);
  }

  it('returns [] for a missing topics dir', async () => {
    expect(await loadTopicSlugs(vault)).toEqual([]);
  });

  it('orders most-recently-modified first and applies the count cap', async () => {
    await writeTopic('oldest', new Date('2026-01-01T00:00:00Z'));
    await writeTopic('middle', new Date('2026-05-01T00:00:00Z'));
    await writeTopic('newest', new Date('2026-08-01T00:00:00Z'));
    expect(await loadTopicSlugs(vault)).toEqual(['newest', 'middle', 'oldest']);
    expect(await loadTopicSlugs(vault, 2)).toEqual(['newest', 'middle']);
  });

  it('stops before the joined list exceeds the char budget', async () => {
    await writeTopic('aaaa', new Date('2026-08-01T00:00:00Z')); // joined len 4
    await writeTopic('bbbb', new Date('2026-07-01T00:00:00Z')); // joined len 10
    await writeTopic('cccc', new Date('2026-06-01T00:00:00Z')); // joined len 16
    expect(await loadTopicSlugs(vault, 400, 10)).toEqual(['aaaa', 'bbbb']);
    expect(await loadTopicSlugs(vault, 400, 9)).toEqual(['aaaa']);
  });
});

describe('buildClassifierSystemPrompt', () => {
  it('includes registry interests as their own section when present', () => {
    const prompt = buildClassifierSystemPrompt(
      vaultContext({ interestParagraphs: ['NVFP4 MoE kernels on GB10', 'agent pipelines'] }),
    );
    expect(prompt).toContain('## User interests (from tenant registry)');
    expect(prompt).toContain('NVFP4 MoE kernels on GB10');
    expect(prompt).toContain('agent pipelines');
  });

  it('omits the interests section entirely when the registry has none', () => {
    const prompt = buildClassifierSystemPrompt(vaultContext());
    expect(prompt).not.toContain('## User interests');
  });

  it('empty interests leave the rest of the prompt byte-identical', () => {
    const base = vaultContext({ topicSlugs: ['slam'] });
    const withInterests = buildClassifierSystemPrompt({
      ...base,
      interestParagraphs: ['robotics'],
    });
    const without = buildClassifierSystemPrompt(base);
    expect(withInterests.replace('\n\n## User interests (from tenant registry)\nrobotics', '')).toBe(
      without,
    );
  });

  it('lists the topic inventory and drops the dead index excerpt', () => {
    const prompt = buildClassifierSystemPrompt(
      vaultContext({ topicSlugs: ['sparse-autoencoders', 'slam'] }),
    );
    expect(prompt).toContain('## Existing wiki topics (for the followup bucket + wikilinks)');
    expect(prompt).toContain('sparse-autoencoders, slam');
    expect(prompt).not.toContain('## Wiki index');
  });

  it('renders (none) when the vault has no topic pages', () => {
    const prompt = buildClassifierSystemPrompt(vaultContext());
    expect(prompt).toContain(
      '## Existing wiki topics (for the followup bucket + wikilinks)\n(none)',
    );
  });

  it('caps each interest paragraph defensively', () => {
    const prompt = buildClassifierSystemPrompt(
      vaultContext({ interestParagraphs: ['a'.repeat(2000)] }),
    );
    expect(prompt).toContain('a'.repeat(600));
    expect(prompt).not.toContain('a'.repeat(601));
  });
});

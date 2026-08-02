/**
 * Cross-stream contracts for the Phase A information-architecture work.
 *
 * Each wave tested its own module against a hand-built fixture of the
 * neighbouring module's output. These tests wire the REAL producers to the
 * REAL consumers, so a change on either side of a seam fails here rather than
 * degrading silently in production:
 *
 *   lint regen-registry  ──registry.json──▶  librarian loadTopicRegistry
 *   formatSourcePage     ──cited_by────────▶  scanTopicRegistry head read
 *   apply write order    ──entity then source (the completion marker)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineCache } from 'thread-phase';

import { scanVault, regenRegistry, type LintCtx } from '../src/phases/lint-phases.js';
import {
  loadTopicRegistry,
  parseRegistryJson,
  REGISTRY_JSON_PATH,
} from '../src/phases/librarian-planner.js';
import {
  renderRegistryJson,
  scanTopicRegistry,
  vocabularyForPrompt,
} from '../src/shared/topic-registry.js';
import { formatSourcePage, formatTopicPage } from '../src/phases/page-templates.js';
import { VaultFs } from '../src/tools/vault.js';

const AT = '2026-08-02T00:15:00.000Z';
const D = (s: string) => new Date(s);

let dir: string;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-phasea-'));
  mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
  mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
  vault = new VaultFs(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lintCtx(): LintCtx {
  return {
    cache: new PipelineCache(),
    dryRun: false,
    generatedAt: AT,
    now: new Date(2026, 7, 2, 0, 15, 0),
    stats: {},
  };
}

async function drainLint(ctx: LintCtx): Promise<void> {
  for (const phase of [scanVault(vault), regenRegistry(vault)]) {
    for await (const _ of phase.run(ctx)) void _;
  }
}

/** A small but realistic vault: two clustered topics, one unclustered, and a
 *  source page written by the real template so the head read is exercised. */
async function seedVault(): Promise<void> {
  await vault.write(
    'wiki/topics/llm-evaluation.md',
    formatTopicPage({
      slug: 'llm-evaluation',
      created: D('2026-01-01T00:00:00Z'),
      updated: D('2026-01-02T00:00:00Z'),
      definition: 'Evaluation methods for large language models.',
      members: [{ filename: 'arxiv-2605-00001', title: 'A paper', collected: D('2026-05-30T00:00:00Z') }],
      relatedTopics: [],
      clusters: ['ai-ml'],
    }),
  );
  await vault.write(
    'wiki/topics/quantum-sensing.md',
    formatTopicPage({
      slug: 'quantum-sensing',
      created: D('2026-01-01T00:00:00Z'),
      updated: D('2026-01-02T00:00:00Z'),
      definition: 'Measurement using quantum coherence.',
      members: [],
      relatedTopics: [],
      clusters: ['physics'],
    }),
  );
  await vault.write(
    'wiki/topics/orphan-topic.md',
    formatTopicPage({
      slug: 'orphan-topic',
      created: D('2026-01-01T00:00:00Z'),
      updated: D('2026-01-02T00:00:00Z'),
      definition: 'A topic nothing has clustered yet.',
      members: [],
      relatedTopics: [],
    }),
  );
  await vault.write(
    'wiki/sources/arxiv-2605-00001.md',
    formatSourcePage({
      stableId: 'arxiv-2605-00001',
      url: 'https://arxiv.org/abs/2605.00001',
      arxivId: '2605.00001',
      sourceName: 'arxiv',
      collected: D('2026-05-30T00:00:00Z'),
      title: 'A paper',
      field: 'AI',
      rigor: 4,
      evidence: 3,
      topics: ['llm-evaluation'],
      cites: [],
      related: [],
      summary: 'Summary text.',
    }),
  );
}

describe('registry.json contract: lint emits, librarian consumes', () => {
  it('the librarian reads the registry the lint pass wrote, at the path it writes it to', async () => {
    await seedVault();
    await drainLint(lintCtx());

    // Same path constant on both sides of the seam.
    expect(await vault.exists(REGISTRY_JSON_PATH)).toBe(true);

    const loaded = await loadTopicRegistry(vault);
    expect(loaded.topics.map((t) => t.slug)).toEqual([
      'llm-evaluation',
      'orphan-topic',
      'quantum-sensing',
    ]);
    expect(loaded.clusters['ai-ml']?.topicCount).toBe(1);
    expect(loaded.clusters['physics']?.topicCount).toBe(1);
    // Per-topic fields the vocabulary ranks by must survive the round trip.
    const llm = loaded.topics.find((t) => t.slug === 'llm-evaluation')!;
    expect(llm.clusters).toEqual(['ai-ml']);
    expect(llm.memberCount).toBe(1);
    expect(llm.oneLiner).toBeTypeOf('string');
  });

  it('renderRegistryJson output parses losslessly for every field parseRegistryJson reads', async () => {
    await seedVault();
    const scanned = scanTopicRegistry(dir, AT);
    const parsed = parseRegistryJson(renderRegistryJson(scanned));
    expect(parsed).not.toBeNull();
    expect(parsed!.generatedAt).toBe(AT);
    expect(parsed!.topics).toEqual(scanned.topics);
    expect(parsed!.clusters).toEqual(scanned.clusters);
  });

  it('the emitted registry yields a non-empty vocabulary for the agent prompts', async () => {
    await seedVault();
    await drainLint(lintCtx());
    const vocab = vocabularyForPrompt(await loadTopicRegistry(vault), { maxChars: 2000 });
    expect(vocab).toContain('llm-evaluation');
    expect(vocab).toContain('quantum-sensing');
    // The unclustered pile is vocabulary too — hiding it is the failure mode
    // that produced 57% `uncategorized`.
    expect(vocab).toContain('orphan-topic');
  });

  it('a corrupt or emptied registry.json falls back to a live scan instead of blinding the agents', async () => {
    await seedVault();
    for (const bad of ['not json at all', '{}', '{"topics":[]}']) {
      await vault.write(REGISTRY_JSON_PATH, bad);
      const loaded = await loadTopicRegistry(vault);
      expect(loaded.topics.length).toBe(3);
    }
  });
});

describe('cited_by contract: page template vs registry head read', () => {
  it('scanTopicRegistry finds cited_by on a source page with a maximal frontmatter block', async () => {
    // Worst case the current writers can produce, using the live vault's
    // longest url (361 chars) and title (232) with the reviewer's caps on
    // topics (4) and cites (6) — every one of those lines precedes
    // `cited_by:`. Nothing bounds url or title, so this is a floor, not a
    // ceiling.
    const cites = Array.from({ length: 6 }, (_, i) => `arxiv-2605-${String(i).padStart(5, '0')}`);
    const page = formatSourcePage({
      stableId: 'arxiv-2605-99999',
      url: `https://example.com/${'p'.repeat(340)}`,
      sourceName: 'arxiv',
      collected: D('2026-05-30T00:00:00Z'),
      title: 'T'.repeat(224),
      field: 'AI',
      rigor: 5,
      evidence: 5,
      topics: ['llm-evaluation', 'quantum-sensing', 'orphan-topic', 'another-long-topic-slug'],
      cites,
      related: cites.slice(0, 3),
      summary: 'Summary text.',
    });
    // Guards the fixture, not the implementation: if a template change ever
    // makes this page small, the test stops exercising the head read at all.
    // 800+ bytes puts `cited_by:` inside the last quarter of the old 1 KiB
    // budget — the margin that motivated widening it.
    expect(page.indexOf('cited_by:')).toBeGreaterThan(800);

    await vault.write('wiki/sources/arxiv-2605-99999.md', page.replace('cited_by: 0', 'cited_by: 7'));
    await vault.write(
      'wiki/topics/llm-evaluation.md',
      formatTopicPage({
        slug: 'llm-evaluation',
        created: D('2026-01-01T00:00:00Z'),
        updated: D('2026-01-02T00:00:00Z'),
        definition: 'Evaluation methods for large language models.',
        members: [
          { filename: 'arxiv-2605-99999', title: 'T', collected: D('2026-05-30T00:00:00Z') },
        ],
        relatedTopics: [],
        clusters: ['ai-ml'],
      }),
    );

    const reg = scanTopicRegistry(dir, AT);
    expect(reg.topics.find((t) => t.slug === 'llm-evaluation')!.citedByTotal).toBe(7);
  });

  it('every new source page is born with the cited_by key the lint pass maintains', () => {
    const page = formatSourcePage({
      stableId: 'arxiv-2605-00002',
      url: 'https://arxiv.org/abs/2605.00002',
      sourceName: 'arxiv',
      collected: D('2026-05-30T00:00:00Z'),
      title: 'B paper',
      field: 'AI',
      topics: ['llm-evaluation'],
      cites: [],
      related: [],
      summary: 'Summary text.',
    });
    expect(page).toContain('\ncited_by: 0\n');
    // Unscored rows stay distinguishable from scored-low ones.
    expect(page).not.toContain('rigor:');
    expect(page).not.toContain('evidence:');
  });
});

describe('apply write order (AGENTS.md: source page written last)', () => {
  it('writes the source page after topic and entity pages', async () => {
    // Structural pin on the seam wave 2 widened: entity upserts were inserted
    // between the topic touches and the source write, and the source page is
    // the article-completion marker recovery keys off.
    const src = readFileSync(join(process.cwd(), 'src/phases/librarian-apply.ts'), 'utf8');
    const topicWrite = src.indexOf('await writer.write(topicPath, content)');
    const entityWrite = src.indexOf('formatEntityPage({');
    const sourceWrite = src.indexOf('await writer.write(plan.sourcePath');
    expect(topicWrite).toBeGreaterThan(-1);
    expect(entityWrite).toBeGreaterThan(-1);
    expect(sourceWrite).toBeGreaterThan(-1);
    expect(topicWrite).toBeLessThan(entityWrite);
    expect(entityWrite).toBeLessThan(sourceWrite);
  });
});

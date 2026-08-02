import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { PipelineCache, type Phase } from 'thread-phase';

import {
  scanVault,
  regenRegistry,
  resolveExternalRefs,
  recountCitations,
  rankTopicMembers,
  regenIndex,
  exportGraph,
  reportLint,
  commitLint,
  computeLintReport,
  duplicateTopicCandidates,
  parseSourcePage,
  rerankMemberSection,
  renderIndexMarkdown,
  renderLogEntry,
  wikilinkTargets,
  LINT_PATHSPECS,
  type LintCtx,
} from '../src/phases/lint-phases.js';
import {
  formatSourcePage,
  stableIdForUrl,
  stableIdToFilename,
} from '../src/phases/page-templates.js';
import { VaultFs } from '../src/tools/vault.js';
import type { GitOps } from '../src/tools/git.js';
import type { TopicRegistry, TopicRecord } from '../src/shared/topic-registry.js';

const AT = '2026-08-02T00:15:00.000Z';
// Local time: localStamp renders the log entry in the operator's timezone.
const NOW = new Date(2026, 7, 2, 0, 15, 0);

let dir: string;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-lint-'));
  mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
  mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
  vault = new VaultFs(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCtx(over: Partial<LintCtx> = {}): LintCtx {
  return {
    cache: new PipelineCache(),
    dryRun: false,
    generatedAt: AT,
    now: NOW,
    stats: {},
    ...over,
  };
}

async function drain(phases: Array<Phase<LintCtx>>, ctx: LintCtx): Promise<unknown[]> {
  const events: unknown[] = [];
  for (const phase of phases) {
    for await (const ev of phase.run(ctx)) events.push(ev);
  }
  return events;
}

interface SourceOpts {
  title?: string;
  collected?: string;
  topics?: string[];
  cites?: string[];
  related?: string[];
  citedBy?: number | null;
  rigor?: number | null;
  body?: string;
}

/** A source page in the shape formatSourcePage emits. */
function source(name: string, opts: SourceOpts = {}): void {
  const fm = [
    '---',
    'type: source',
    'status: ingested',
    `url: https://example.test/${name}`,
    'source_name: RSS',
    `collected: ${opts.collected ?? '2026-07-01'}`,
    `title: "${opts.title ?? name}"`,
    'field: test',
  ];
  if (opts.rigor !== undefined && opts.rigor !== null) fm.push(`rigor: ${opts.rigor}`);
  fm.push(
    `topics: [${(opts.topics ?? []).join(', ')}]`,
    `cites: [${(opts.cites ?? []).join(', ')}]`,
  );
  if (opts.citedBy !== undefined && opts.citedBy !== null) fm.push(`cited_by: ${opts.citedBy}`);
  fm.push(`related: [${(opts.related ?? []).join(', ')}]`, '---');
  const body = [
    '',
    `# ${opts.title ?? name}`,
    '',
    '## Summary',
    '',
    opts.body ?? 'Body text.',
    '',
    '## Cited by',
    '',
  ];
  writeFileSync(join(dir, 'wiki/sources', `${name}.md`), `${fm.join('\n')}\n${body.join('\n')}`);
}

interface TopicOpts {
  clusters?: string[];
  relatedTopics?: string[];
  members?: Array<{ name: string; title?: string; collected?: string }>;
  memberSection?: string[];
}

function topic(slug: string, opts: TopicOpts = {}): void {
  const fm = ['---', 'type: topic', 'status: active', 'created: 2026-01-01', 'updated: 2026-07-01'];
  if (opts.clusters?.length) fm.push(`clusters: [${opts.clusters.join(', ')}]`);
  fm.push(`related_topics: [${(opts.relatedTopics ?? []).join(', ')}]`, '---');
  const body = ['', `# ${slug}`, '', 'A definition sentence.', '', '## Member sources', ''];
  if (opts.memberSection) {
    body.push(...opts.memberSection);
  } else if (opts.members?.length) {
    for (const m of opts.members) {
      body.push(
        `- [[wiki/sources/${m.name}]] — ${m.title ?? m.name} (${m.collected ?? '2026-07-01'})`,
      );
    }
  } else {
    body.push('_None yet._');
  }
  body.push('');
  writeFileSync(join(dir, 'wiki/topics', `${slug}.md`), `${fm.join('\n')}\n${body.join('\n')}`);
}

interface ArxivSourceOpts {
  title?: string;
  collected?: string;
  topics?: string[];
  cites?: string[];
  /** arXiv ids rendered under `## External references`. */
  refs?: string[];
  /** DOIs rendered under `## External references`. */
  doiRefs?: string[];
}

/**
 * A source page written by the REAL producer.
 *
 * The resolution pass has to recognise what the librarian wrote — section
 * order, the `— not yet in library` suffix, the stable-id naming — so the
 * fixture goes through `formatSourcePage` and the same stable-id helpers
 * rather than re-implementing the format here. Returns the page name.
 */
function arxivSource(arxivId: string, opts: ArxivSourceOpts = {}): string {
  const url = `https://arxiv.org/abs/${arxivId}`;
  const stableId = stableIdForUrl(url)!;
  const filename = stableIdToFilename(stableId);
  const content = formatSourcePage({
    stableId,
    url,
    arxivId,
    sourceName: 'arXiv',
    collected: new Date(`${opts.collected ?? '2026-07-01'}T00:00:00Z`),
    title: opts.title ?? arxivId,
    field: 'AI/ML',
    topics: opts.topics ?? [],
    cites: opts.cites ?? [],
    externalRefs: [
      ...(opts.refs ?? []).map((id) => ({
        label: `arXiv:${id}`,
        url: `https://arxiv.org/abs/${id}`,
      })),
      ...(opts.doiRefs ?? []).map((doi) => ({
        label: `doi:${doi}`,
        url: `https://doi.org/${doi}`,
      })),
    ],
    summary: 'A summary paragraph.',
  });
  writeFileSync(join(dir, 'wiki/sources', `${filename}.md`), content);
  return filename;
}

/** Every file in the fixture vault, path → contents. */
function snapshot(root = dir): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.set(relative(root, abs), readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}

function read(path: string): string {
  return readFileSync(join(dir, path), 'utf8');
}

function fakeRecord(over: Partial<TopicRecord> & { slug: string }): TopicRecord {
  return {
    title: over.slug,
    oneLiner: null,
    clusters: [],
    memberCount: 0,
    citedByTotal: 0,
    updated: null,
    ...over,
  };
}

function fakeRegistry(topics: TopicRecord[]): TopicRegistry {
  return { topics, clusters: {}, generatedAt: AT };
}

// ---------------------------------------------------------------------------

describe('parseSourcePage', () => {
  it('reads the frontmatter the lint passes depend on', () => {
    source('a', { title: 'Some Paper', cites: ['b', 'c'], topics: ['x'], citedBy: 2, rigor: 4 });
    const record = parseSourcePage('a', read('wiki/sources/a.md'));

    expect(record).toMatchObject({
      name: 'a',
      title: 'Some Paper',
      collected: '2026-07-01',
      topics: ['x'],
      cites: ['b', 'c'],
      citedBy: 2,
      rigor: 4,
      hasFrontmatter: true,
    });
  });

  it('reports a missing cited_by as null, distinct from zero', () => {
    source('a');
    expect(parseSourcePage('a', read('wiki/sources/a.md')).citedBy).toBeNull();
    source('b', { citedBy: 0 });
    expect(parseSourcePage('b', read('wiki/sources/b.md')).citedBy).toBe(0);
  });

  it('flags a page with no frontmatter block', () => {
    writeFileSync(join(dir, 'wiki/sources/legacy.md'), '# Legacy\n\nNo frontmatter here.\n');
    const record = parseSourcePage('legacy', read('wiki/sources/legacy.md'));
    expect(record.hasFrontmatter).toBe(false);
    expect(record.title).toBe('Legacy');
  });
});

describe('wikilinkTargets', () => {
  it('collects distinct targets, stripping labels, anchors, and .md', () => {
    const text = '[[wiki/sources/a|Label]] [[wiki/topics/b#Section]] [[wiki/sources/a]] [[wiki/entities/c.md]]';
    expect(wikilinkTargets(text)).toEqual([
      'wiki/sources/a',
      'wiki/topics/b',
      'wiki/entities/c',
    ]);
  });
});

describe('regen-registry', () => {
  it('writes the registry page and registry.json', async () => {
    source('a');
    topic('cosmology', { clusters: ['physics'], members: [{ name: 'a' }] });
    const ctx = makeCtx();
    await drain([scanVault(vault), regenRegistry(vault)], ctx);

    const page = read('wiki/topics/_registry.md');
    expect(page).toContain('# Topic registry');
    expect(page).toContain('### physics (1)');
    const json = JSON.parse(read('registry.json'));
    expect(json.generatedAt).toBe(AT);
    expect(json.topics).toEqual([
      expect.objectContaining({ slug: 'cosmology', clusters: ['physics'], memberCount: 1 }),
    ]);
    expect(ctx.writes!.written).toEqual(['wiki/topics/_registry.md', 'registry.json']);
  });

  it('rewrites nothing on a second run over an unchanged vault', async () => {
    source('a');
    topic('cosmology', { clusters: ['physics'], members: [{ name: 'a' }] });
    await drain([scanVault(vault), regenRegistry(vault)], makeCtx());

    const ctx = makeCtx();
    await drain([scanVault(vault), regenRegistry(vault)], ctx);
    expect(ctx.writes!.written).toEqual([]);
    expect(ctx.writes!.unchanged).toBe(2);
  });

  it('never ingests its own output as a topic', async () => {
    source('a');
    topic('cosmology', { members: [{ name: 'a' }] });
    await drain([scanVault(vault), regenRegistry(vault)], makeCtx());

    const ctx = makeCtx();
    await drain([scanVault(vault), regenRegistry(vault)], ctx);
    expect(ctx.registry!.topics.map((t) => t.slug)).toEqual(['cosmology']);
  });
});

describe('recount-citations', () => {
  it('recomputes cited_by from inbound cites edges', async () => {
    source('a', { cites: ['b', 'c'] });
    source('b', { cites: ['c'], citedBy: 0 });
    source('c', { citedBy: 99 });
    const ctx = makeCtx();
    await drain([scanVault(vault), recountCitations(vault)], ctx);

    expect(read('wiki/sources/c.md')).toContain('cited_by: 2');
    expect(read('wiki/sources/b.md')).toContain('cited_by: 1');
    expect(ctx.stats.citedByUpdated).toBe(3); // c corrected, b bumped, a gains the key
  });

  it('adds the line when missing and leaves the rest of the page byte-for-byte', async () => {
    source('a', { cites: ['b'] });
    source('b');
    const before = read('wiki/sources/b.md');
    expect(before).not.toContain('cited_by');

    await drain([scanVault(vault), recountCitations(vault)], makeCtx());
    const after = read('wiki/sources/b.md');
    expect(after).toContain('\ncited_by: 1\n');
    expect(after.replace('\ncited_by: 1\n---', '\n---')).toBe(before);
  });

  it('leaves an already-correct page untouched', async () => {
    source('a', { cites: ['b'] });
    source('b', { citedBy: 1 });
    const before = read('wiki/sources/b.md');
    const ctx = makeCtx();
    await drain([scanVault(vault), recountCitations(vault)], ctx);

    expect(read('wiki/sources/b.md')).toBe(before);
    expect(ctx.writes!.written).toEqual(['wiki/sources/a.md']); // only `a` gains cited_by: 0
  });

  it('counts a page with no frontmatter as skipped rather than rewriting it', async () => {
    writeFileSync(join(dir, 'wiki/sources/legacy.md'), '# Legacy\n\nNo frontmatter.\n');
    const before = read('wiki/sources/legacy.md');
    const events = (await drain([scanVault(vault), recountCitations(vault)], makeCtx())) as Array<{
      phase?: string;
      counts?: Record<string, number>;
    }>;

    expect(read('wiki/sources/legacy.md')).toBe(before);
    const recount = events.find((e) => e.phase === 'recount-citations')!;
    expect(recount.counts).toMatchObject({ updated: 0, skippedNoFrontmatter: 1 });
  });

  it('counts one edge per citing page even when a cite is repeated', async () => {
    source('a', { cites: ['b', 'b'] });
    source('b');
    await drain([scanVault(vault), recountCitations(vault)], makeCtx());
    expect(read('wiki/sources/b.md')).toContain('cited_by: 1');
  });
});

describe('resolve-external-refs', () => {
  type Ev = { phase?: string; key?: string; counts?: Record<string, number>; value?: unknown };
  const countsOf = (events: unknown[]): Record<string, number> =>
    (events as Ev[]).find((e) => e.phase === 'resolve-external-refs')!.counts!;

  it('migrates a landed ref into cites, the in-library section, and the target Cited by', async () => {
    const target = arxivSource('2605.03823', { title: 'Landed Paper' });
    // The second ref never landed and must survive untouched.
    const citer = arxivSource('2607.00001', {
      title: 'Citing Paper',
      refs: ['2605.03823', '2601.09999'],
    });

    const ctx = makeCtx();
    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], ctx);

    const page = read(`wiki/sources/${citer}.md`);
    expect(page).toContain(`cites: [${target}]`);
    expect(page).toContain(`- [[wiki/sources/${target}]]`);
    expect(page).not.toContain('_None resolved against the current library._');
    expect(page).not.toContain('arXiv:2605.03823');
    expect(page).toContain('## External references');
    expect(page).toContain(
      '- [arXiv:2601.09999](https://arxiv.org/abs/2601.09999) — not yet in library',
    );

    expect(read(`wiki/sources/${target}.md`)).toContain(
      `- [[wiki/sources/${citer}]] — Citing Paper`,
    );

    // In-memory records carry the new edge for the passes that follow.
    const record = ctx.sources!.find((s) => s.name === citer)!;
    expect(record.cites).toEqual([target]);
    expect(record.externalRefs.map((r) => r.label)).toEqual(['arXiv:2601.09999']);
    expect(record.links).toContain(`wiki/sources/${target}`);
    expect(ctx.inDegree!.get(target)).toBe(1);

    expect(countsOf(events)).toMatchObject({
      pagesResolved: 1,
      edgesAdded: 1,
      sectionsEmptied: 0,
      skippedUnparseable: 0,
    });
  });

  it('preserves the rest of the citing page byte-for-byte', async () => {
    arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823', '2601.09999'] });
    const before = read(`wiki/sources/${citer}.md`);

    await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());
    const after = read(`wiki/sources/${citer}.md`);

    // Only the three touched lines differ: the cites: frontmatter, the moved
    // entry, and the placeholder it replaced.
    const strip = (t: string): string[] =>
      t
        .split('\n')
        .filter(
          (l) =>
            !l.startsWith('cites:') &&
            !l.startsWith('- [[wiki/sources/') &&
            !l.startsWith('- [arXiv:2605.03823]') &&
            l !== '_None resolved against the current library._',
        );
    expect(strip(after)).toEqual(strip(before));
  });

  it('drops the External references heading when the last entry leaves', async () => {
    const target = arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823'] });

    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());
    const page = read(`wiki/sources/${citer}.md`);

    expect(page).not.toContain('## External references');
    expect(page).toContain(
      `## Cited references in this library\n\n- [[wiki/sources/${target}]]\n\n## Related sources`,
    );
    expect(countsOf(events)).toMatchObject({ pagesResolved: 1, sectionsEmptied: 1 });
  });

  it('resolves one of three refs and leaves the other two external', async () => {
    const target = arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', {
      refs: ['2601.09998', '2605.03823', '2601.09999'],
    });

    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());
    const page = read(`wiki/sources/${citer}.md`);
    const external = page.slice(page.indexOf('## External references'));

    expect(external.split('\n').filter((l) => l.startsWith('- ['))).toEqual([
      '- [arXiv:2601.09998](https://arxiv.org/abs/2601.09998) — not yet in library',
      '- [arXiv:2601.09999](https://arxiv.org/abs/2601.09999) — not yet in library',
    ]);
    expect(page).toContain(`cites: [${target}]`);
    expect(countsOf(events)).toMatchObject({
      pagesResolved: 1,
      edgesAdded: 1,
      sectionsEmptied: 0,
    });
  });

  it('creates the in-library section in canonical position on a page that lacks it', async () => {
    const target = arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823', '2601.09999'] });
    const path = join(dir, 'wiki/sources', `${citer}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '## Cited references in this library\n\n_None resolved against the current library._\n\n',
        '',
      ),
    );

    await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());

    // Between Topics and External references, where formatSourcePage puts it.
    expect(read(`wiki/sources/${citer}.md`)).toContain(
      `## Cited references in this library\n\n- [[wiki/sources/${target}]]\n\n## External references`,
    );
  });

  it('resolves DOI refs through the same stable-id naming as the librarian', async () => {
    const doi = '10.1038/s41586-024-00001';
    const doiUrl = `https://doi.org/${doi}`;
    const stableId = stableIdForUrl(doiUrl)!;
    const target = stableIdToFilename(stableId);
    writeFileSync(
      join(dir, 'wiki/sources', `${target}.md`),
      formatSourcePage({
        stableId,
        url: doiUrl,
        doi,
        sourceName: 'journal',
        collected: new Date('2026-07-01T00:00:00Z'),
        title: 'Landed DOI Paper',
        field: 'bio',
        topics: [],
        cites: [],
        summary: 'A summary paragraph.',
      }),
    );
    const citer = arxivSource('2607.00001', { doiRefs: [doi] });

    await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());
    expect(target).toBe('doi-10-1038-s41586-024-00001');
    expect(read(`wiki/sources/${citer}.md`)).toContain(`cites: [${target}]`);
    expect(read(`wiki/sources/${target}.md`)).toContain(`- [[wiki/sources/${citer}]]`);
  });

  it('is idempotent: a second run over the resolved vault writes nothing', async () => {
    arxivSource('2605.03823');
    arxivSource('2607.00001', { refs: ['2605.03823', '2601.09999'] });
    await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());
    const after = snapshot();

    const ctx = makeCtx();
    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], ctx);

    expect(snapshot()).toEqual(after);
    expect(ctx.writes?.written ?? []).toEqual([]);
    expect(countsOf(events)).toMatchObject({ pagesResolved: 0, edgesAdded: 0 });
  });

  it('refuses to touch a page whose External references section it cannot parse', async () => {
    arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823'] });
    const path = join(dir, 'wiki/sources', `${citer}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '## External references\n\n',
        '## External references\n\nHand-written note about these refs.\n\n',
      ),
    );
    const before = read(`wiki/sources/${citer}.md`);

    const ctx = makeCtx();
    const events = (await drain(
      [scanVault(vault), resolveExternalRefs(vault)],
      ctx,
    )) as Ev[];

    expect(read(`wiki/sources/${citer}.md`)).toBe(before);
    expect(ctx.writes?.written ?? []).toEqual([]);
    expect(countsOf(events)).toMatchObject({ pagesResolved: 0, skippedUnparseable: 1 });
    expect(events.find((e) => e.key === 'lint-unparseable-external-refs')!.value).toEqual([
      citer,
    ]);
  });

  it('refuses a page whose cites frontmatter is not the inline array the writers emit', async () => {
    arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823'] });
    const path = join(dir, 'wiki/sources', `${citer}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('cites: []\n', 'cites:\n  - some-legacy-name\n'),
    );
    const before = read(`wiki/sources/${citer}.md`);

    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());

    expect(read(`wiki/sources/${citer}.md`)).toBe(before);
    expect(countsOf(events)).toMatchObject({ pagesResolved: 0, skippedUnparseable: 1 });
  });

  it('leaves refs alone when the paper is still missing or carries no stable identity', async () => {
    const citer = arxivSource('2607.00001', { refs: ['2601.09999'] });
    const path = join(dir, 'wiki/sources', `${citer}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '## Related sources',
        '- [Some Blog](https://example.test/post) — not yet in library\n\n## Related sources',
      ),
    );
    const before = read(`wiki/sources/${citer}.md`);

    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());
    expect(read(`wiki/sources/${citer}.md`)).toBe(before);
    expect(countsOf(events)).toMatchObject({ pagesResolved: 0, skippedUnparseable: 0 });
  });

  it('never draws a self-edge through a paper own arXiv DataCite DOI', async () => {
    // The enrichment step routinely lists a paper's own 10.48550 DOI among its
    // references, so the citing page and the "landed" page are one paper under
    // two stable names.
    const doi = '10.48550/arxiv.2607.00001';
    const doiUrl = `https://doi.org/${doi}`;
    const stableId = stableIdForUrl(doiUrl)!;
    const alias = stableIdToFilename(stableId);
    writeFileSync(
      join(dir, 'wiki/sources', `${alias}.md`),
      formatSourcePage({
        stableId,
        url: doiUrl,
        doi,
        sourceName: 'arXiv',
        collected: new Date('2026-07-01T00:00:00Z'),
        title: 'Same Paper, DOI Copy',
        field: 'AI/ML',
        topics: [],
        cites: [],
        summary: 'A summary paragraph.',
      }),
    );
    const citer = arxivSource('2607.00001', { doiRefs: [doi] });
    expect(alias).toBe(`doi-10-48550-${citer}`);
    const before = read(`wiki/sources/${citer}.md`);

    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], makeCtx());

    expect(read(`wiki/sources/${citer}.md`)).toBe(before);
    expect(read(`wiki/sources/${alias}.md`)).not.toContain(`- [[wiki/sources/${citer}]]`);
    expect(countsOf(events)).toMatchObject({ pagesResolved: 0, edgesAdded: 0 });
  });

  it('feeds the new edge to recount-citations in the same run', async () => {
    const target = arxivSource('2605.03823');
    arxivSource('2607.00001', { refs: ['2605.03823'] });

    const ctx = makeCtx();
    await drain(
      [scanVault(vault), resolveExternalRefs(vault), recountCitations(vault)],
      ctx,
    );

    expect(read(`wiki/sources/${target}.md`)).toContain('cited_by: 1');
    expect(ctx.stats.citedByUpdated).toBe(1);
  });

  it('feeds the new edge to export-graph in the same run', async () => {
    const target = arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823'] });

    await drain(
      [scanVault(vault), resolveExternalRefs(vault), recountCitations(vault), exportGraph(vault)],
      makeCtx(),
    );
    const graph = JSON.parse(read('graph.json'));

    expect(graph.edges).toContainEqual({
      from: `wiki/sources/${citer}`,
      to: `wiki/sources/${target}`,
      type: 'cites',
    });
    expect(graph.nodes).toContainEqual({
      id: `wiki/sources/${target}`,
      type: 'source',
      title: '2605.03823',
      importance: { citedBy: 1 },
    });
  });

  it('re-ranks topic members against the freshly resolved edge', async () => {
    const target = arxivSource('2605.03823');
    const other = arxivSource('2604.01111', { collected: '2026-07-20' });
    arxivSource('2607.00001', { refs: ['2605.03823'] });
    topic('t', {
      members: [
        { name: other, collected: '2026-07-20' },
        { name: target, collected: '2026-07-01' },
      ],
    });

    await drain(
      [scanVault(vault), resolveExternalRefs(vault), recountCitations(vault), rankTopicMembers(vault)],
      makeCtx(),
    );

    const lines = read('wiki/topics/t.md').split('\n').filter((l) => l.startsWith('- [['));
    expect(lines[0]).toContain(`wiki/sources/${target}`);
  });

  it('reports every would-write in dry-run and touches nothing', async () => {
    const target = arxivSource('2605.03823');
    const citer = arxivSource('2607.00001', { refs: ['2605.03823'] });
    const before = snapshot();

    const ctx = makeCtx({ dryRun: true });
    const events = await drain([scanVault(vault), resolveExternalRefs(vault)], ctx);

    expect(snapshot()).toEqual(before);
    expect(ctx.writes!.written).toEqual([]);
    // Backlink first, citing page second — the librarian's write order.
    expect(ctx.writes!.wouldWrite).toEqual([
      `wiki/sources/${target}.md`,
      `wiki/sources/${citer}.md`,
    ]);
    expect(countsOf(events)).toMatchObject({ pagesResolved: 1, edgesAdded: 1, dryRun: 1 });
    // The in-memory graph still reflects the resolution, as in every dry run.
    expect(ctx.inDegree!.get(target)).toBe(1);
  });
});

describe('rerankMemberSection', () => {
  const keyOf = (citations: Record<string, number>, dates: Record<string, string>) =>
    (name: string, lineDate: string | null) => ({
      citedBy: citations[name] ?? 0,
      collected: dates[name] ?? lineDate ?? '',
    });

  it('orders by cited_by desc, then collected desc, then filename', () => {
    topic('t', {
      members: [
        { name: 'old-uncited', collected: '2026-01-01' },
        { name: 'new-uncited', collected: '2026-06-01' },
        { name: 'cited', collected: '2025-01-01' },
      ],
    });
    const result = rerankMemberSection(read('wiki/topics/t.md'), keyOf({ cited: 3 }, {}));

    expect(result.status).toBe('reordered');
    const members = result.text
      .split('\n')
      .filter((l) => l.startsWith('- [['))
      .map((l) => /wiki\/sources\/([^\]]+)/.exec(l)![1]);
    expect(members).toEqual(['cited', 'new-uncited', 'old-uncited']);
  });

  it('is stable: a second pass over sorted output changes nothing', () => {
    topic('t', {
      members: [
        { name: 'b', collected: '2026-06-01' },
        { name: 'a', collected: '2026-06-01' },
      ],
    });
    const key = keyOf({}, {});
    const once = rerankMemberSection(read('wiki/topics/t.md'), key);
    const twice = rerankMemberSection(once.text, key);
    expect(twice.status).toBe('unchanged');
    expect(twice.text).toBe(once.text);
  });

  it('preserves everything outside the member section', () => {
    topic('t', {
      relatedTopics: ['other'],
      members: [
        { name: 'a', collected: '2026-01-01' },
        { name: 'b', collected: '2026-06-01' },
      ],
    });
    const before = read('wiki/topics/t.md');
    const result = rerankMemberSection(before, keyOf({}, {}));
    const strip = (t: string) => t.split('\n').filter((l) => !l.startsWith('- [[wiki/sources/'));
    expect(strip(result.text)).toEqual(strip(before));
  });

  it('refuses to touch a section it cannot parse', () => {
    topic('t', {
      memberSection: [
        '- [[wiki/sources/a]] — A (2026-01-01)',
        'Some hand-written prose about the members.',
      ],
    });
    const before = read('wiki/topics/t.md');
    const result = rerankMemberSection(before, keyOf({}, {}));
    expect(result.status).toBe('unparseable');
    expect(result.text).toBe(before);
  });

  it('reports a page with no member section', () => {
    writeFileSync(join(dir, 'wiki/topics/t.md'), '---\ntype: topic\n---\n\n# T\n\nProse only.\n');
    expect(rerankMemberSection(read('wiki/topics/t.md'), keyOf({}, {})).status).toBe('no-section');
  });
});

describe('rank-topic-members', () => {
  it('rewrites member order using the freshly recounted in-degree', async () => {
    source('cited');
    source('recent', { collected: '2026-07-20' });
    source('citer-1', { cites: ['cited'] });
    source('citer-2', { cites: ['cited'] });
    topic('t', {
      members: [
        { name: 'recent', collected: '2026-07-20' },
        { name: 'cited', collected: '2026-01-01' },
      ],
    });

    const ctx = makeCtx();
    await drain(
      [scanVault(vault), recountCitations(vault), rankTopicMembers(vault)],
      ctx,
    );

    const lines = read('wiki/topics/t.md').split('\n').filter((l) => l.startsWith('- [['));
    expect(lines[0]).toContain('wiki/sources/cited');
    expect(ctx.stats.membersReranked).toBe(1);
  });

  it('counts unparseable pages and emits them without writing', async () => {
    topic('t', {
      memberSection: ['- [[wiki/sources/a]] — A (2026-01-01)', 'prose', '- [[wiki/sources/b]] — B (2026-06-01)'],
    });
    const before = read('wiki/topics/t.md');
    const events = (await drain([scanVault(vault), rankTopicMembers(vault)], makeCtx())) as Array<{
      phase?: string;
      key?: string;
      counts?: Record<string, number>;
      value?: unknown;
    }>;

    expect(read('wiki/topics/t.md')).toBe(before);
    expect(events.find((e) => e.phase === 'rank-topic-members')!.counts).toMatchObject({
      unparseable: 1,
      reordered: 0,
    });
    expect(events.find((e) => e.key === 'lint-unparseable-member-sections')!.value).toEqual(['t']);
  });
});

describe('regen-index', () => {
  it('renders a navigation surface, not a catalog', async () => {
    for (let i = 0; i < 40; i++) {
      source(`s${String(i).padStart(2, '0')}`, {
        collected: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
        topics: i % 2 === 0 ? ['cosmology'] : ['uncategorized'],
      });
    }
    topic('cosmology', {
      clusters: ['physics'],
      members: Array.from({ length: 20 }, (_, i) => ({ name: `s${String(i * 2).padStart(2, '0')}` })),
    });
    mkdirSync(join(dir, 'wiki/projects'), { recursive: true });
    writeFileSync(join(dir, 'wiki/projects/autonome.md'), '# Autonome\n');

    await drain([scanVault(vault), regenIndex(vault)], makeCtx());
    const index = read('index.md');

    expect(index).toContain('# Wiki Index');
    expect(index).toContain('[[wiki/topics/_registry]]');
    expect(index).toContain('### physics (1)');
    expect(index).toContain('- [[wiki/topics/cosmology]] — 20 sources');
    expect(index).toContain('[[wiki/projects/autonome]]');
    expect(index).toContain('- Sources: 40');
    expect(index).toContain('- Sources with no topic assigned: 20');
    expect(index).toContain(`- Generated: ${AT}`);

    // Recent additions are capped and newest-first.
    const recent = index.slice(index.indexOf('## Recent additions'), index.indexOf('## Stats'));
    const recentLinks = recent.split('\n').filter((l) => l.startsWith('- [['));
    expect(recentLinks).toHaveLength(30);
    expect(recentLinks[0]).toContain('(2026-07-28)');
  });

  it('elides long cluster listings into the registry pointer', () => {
    const topics = Array.from({ length: 25 }, (_, i) =>
      fakeRecord({ slug: `t${String(i).padStart(2, '0')}`, clusters: ['ai-ml'], memberCount: 25 - i }),
    );
    const index = renderIndexMarkdown({
      generatedAt: AT,
      registry: { topics, clusters: { 'ai-ml': { topicCount: 25 } }, generatedAt: AT },
      sources: [],
      entities: [],
      families: [],
    });

    expect(index).toContain('### ai-ml (25)');
    expect(index).toContain('- …and 5 more in [[wiki/topics/_registry]]');
  });

  it('surfaces the unclustered pile as its own group', () => {
    const index = renderIndexMarkdown({
      generatedAt: AT,
      registry: fakeRegistry([fakeRecord({ slug: 'loose', memberCount: 2 })]),
      sources: [],
      entities: [],
      families: [],
    });
    expect(index).toContain('### (unclustered) (1)');
  });
});

describe('export-graph', () => {
  it('writes graph.json with nodes and edges drawn from the same scan', async () => {
    source('a', { cites: ['b'], rigor: 4, body: 'Mentions [[wiki/entities/deepmind]].' });
    source('b');
    topic('cosmology', { clusters: ['physics'], members: [{ name: 'a' }, { name: 'b' }] });
    mkdirSync(join(dir, 'wiki/entities'), { recursive: true });
    writeFileSync(join(dir, 'wiki/entities/deepmind.md'), '# DeepMind\n');

    await drain([scanVault(vault), recountCitations(vault), exportGraph(vault)], makeCtx());
    const graph = JSON.parse(read('graph.json'));

    expect(graph.generatedAt).toBe(AT);
    expect(graph.nodes).toContainEqual({
      id: 'wiki/sources/a',
      type: 'source',
      title: 'a',
      importance: { rigor: 4 },
    });
    expect(graph.nodes).toContainEqual({
      id: 'wiki/sources/b',
      type: 'source',
      title: 'b',
      importance: { citedBy: 1 },
    });
    expect(graph.nodes).toContainEqual({ id: 'cluster:physics', type: 'cluster', title: 'physics' });
    expect(graph.edges).toContainEqual({
      from: 'wiki/sources/a',
      to: 'wiki/entities/deepmind',
      type: 'mentions',
    });
    expect(graph.edges).toContainEqual({
      from: 'wiki/topics/cosmology',
      to: 'wiki/sources/a',
      type: 'member',
    });
  });

  it('is deterministic across runs over an unchanged vault', async () => {
    source('a', { cites: ['b'] });
    source('b');
    topic('t', { members: [{ name: 'a' }, { name: 'b' }] });
    await drain([scanVault(vault), exportGraph(vault)], makeCtx());
    const first = read('graph.json');

    const ctx = makeCtx();
    await drain([scanVault(vault), exportGraph(vault)], ctx);
    expect(read('graph.json')).toBe(first);
    expect(ctx.writes!.written).toEqual([]);
  });
});

describe('computeLintReport', () => {
  it('finds broken links, orphans, and stubs', async () => {
    source('linked', { body: 'See [[wiki/sources/ghost]] and [[wiki/topics/nope]].' });
    source('orphan');
    source('cited');
    source('citer', { cites: ['cited'] });
    topic('has-members', { members: [{ name: 'linked' }, { name: 'citer' }] });
    topic('stub', { members: [{ name: 'linked' }] });

    const ctx = makeCtx();
    await drain([scanVault(vault), reportLint(vault)], ctx);
    const report = ctx.report!;

    expect(report.brokenLinks.map((b) => b.target)).toEqual([
      'wiki/sources/ghost',
      'wiki/topics/nope',
    ]);
    expect(report.brokenLinkTotal).toBe(2);
    expect(report.orphanSources).toEqual(['orphan']);
    expect(report.stubTopics).toEqual(['stub']);
  });

  it('ignores Obsidian short links, which resolve by filename anywhere', () => {
    const report = computeLintReport({
      sources: [
        {
          name: 'a',
          title: 'a',
          collected: null,
          topics: [],
          cites: [],
          related: [],
          entities: [],
          rigor: null,
          citedBy: null,
          hasFrontmatter: true,
          links: ['Samsung', 'wiki/sources/ghost'],
          externalRefs: [],
          externalRefsUnparseable: false,
        },
      ],
      topics: [],
      registry: fakeRegistry([]),
      pageExists: () => false,
    });
    expect(report.brokenLinks.map((b) => b.target)).toEqual(['wiki/sources/ghost']);
  });

  it('ranks broken targets by how many pages reference them', () => {
    const link = (name: string, links: string[]) => ({
      name,
      title: name,
      collected: null,
      topics: [],
      cites: [],
      related: [],
      entities: [],
      rigor: null,
      citedBy: null,
      hasFrontmatter: true,
      links,
      externalRefs: [],
      externalRefsUnparseable: false,
    });
    const report = computeLintReport({
      sources: [
        link('a', ['wiki/topics/popular-ghost', 'wiki/topics/rare-ghost']),
        link('b', ['wiki/topics/popular-ghost']),
      ],
      topics: [],
      registry: fakeRegistry([]),
      pageExists: () => false,
    });
    expect(report.brokenLinks).toEqual([
      { target: 'wiki/topics/popular-ghost', refCount: 2, sample: 'wiki/sources/a' },
      { target: 'wiki/topics/rare-ghost', refCount: 1, sample: 'wiki/sources/a' },
    ]);
  });
});

describe('duplicateTopicCandidates', () => {
  it('pairs near-identical slugs once, in slug order', () => {
    const reg = fakeRegistry(
      ['agent-memory', 'agent-memories', 'quantum-sensing', 'photosynthesis'].map((slug) =>
        fakeRecord({ slug }),
      ),
    );
    expect(duplicateTopicCandidates(reg)).toEqual([{ a: 'agent-memories', b: 'agent-memory' }]);
  });

  it('returns nothing when every slug is distinct', () => {
    const reg = fakeRegistry(
      ['cosmology', 'robotics', 'photosynthesis'].map((slug) => fakeRecord({ slug })),
    );
    expect(duplicateTopicCandidates(reg)).toEqual([]);
  });

  it('rejects unrelated slugs that merely share a generic token', () => {
    const reg = fakeRegistry(
      ['axion-physics', '2d-graphene-physics', 'particle-physics'].map((slug) =>
        fakeRecord({ slug }),
      ),
    );
    expect(duplicateTopicCandidates(reg)).toEqual([]);
  });
});

describe('report-lint', () => {
  it('appends exactly one lint entry to log.md', async () => {
    source('orphan');
    topic('stub', { members: [{ name: 'orphan' }] });
    writeFileSync(join(dir, 'log.md'), '# Log\n\n## [2026-08-01 19:24] ingest-v3 | something\n');

    await drain([scanVault(vault), reportLint(vault)], makeCtx());
    const log = read('log.md');
    const entries = log.split('\n').filter((l) => l.includes('] lint |'));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('## [2026-08-02 00:15] lint |');
    expect(log).toContain('- stub topics: 1 (top: stub)');
    expect(log).toContain('## [2026-08-01 19:24] ingest-v3 | something');
  });

  it('emits the full lists as a data event, capped', async () => {
    source('orphan');
    const ctx = makeCtx();
    const events = (await drain([scanVault(vault), reportLint(vault)], ctx)) as Array<{
      key?: string;
      value?: { orphanSources?: string[]; truncatedAt?: number };
    }>;
    const report = events.find((e) => e.key === 'lint-report')!;
    expect(report.value!.orphanSources).toEqual(['orphan']);
    expect(report.value!.truncatedAt).toBe(2000);
  });
});

describe('renderLogEntry', () => {
  it('names the top offenders and shows an em dash for empty categories', () => {
    const entry = renderLogEntry(
      NOW,
      { topics: 2, sources: 3, citedByUpdated: 1, membersReranked: 0, filesWritten: 4 },
      {
        brokenLinks: [{ target: 'wiki/topics/ghost', refCount: 3, sample: 'wiki/sources/a' }],
        brokenLinkTotal: 3,
        orphanSources: [],
        stubTopics: ['stub'],
        duplicateTopics: [{ a: 'x', b: 'y' }],
      },
    );

    expect(entry).toContain('## [2026-08-02 00:15] lint | 2 topics · 3 sources');
    expect(entry).toContain('broken wikilinks: 3 across 1 targets (top: wiki/topics/ghost ×3)');
    expect(entry).toContain('orphan sources: 0 (top: —)');
    expect(entry).toContain('near-duplicate topics: 1 (top: x ↔ y)');
  });
});

describe('dry run', () => {
  it('reports every would-write and touches nothing', async () => {
    source('a', { cites: ['b'] });
    source('b');
    topic('t', {
      members: [
        { name: 'a', collected: '2026-01-01' },
        { name: 'b', collected: '2026-06-01' },
      ],
    });
    writeFileSync(join(dir, 'log.md'), '# Log\n');
    const before = snapshot();

    const ctx = makeCtx({ dryRun: true });
    await drain(
      [
        scanVault(vault),
        resolveExternalRefs(vault),
        regenRegistry(vault),
        recountCitations(vault),
        rankTopicMembers(vault),
        regenIndex(vault),
        exportGraph(vault),
        reportLint(vault),
      ],
      ctx,
    );

    expect(snapshot()).toEqual(before);
    expect(ctx.writes!.written).toEqual([]);
    expect(ctx.writes!.wouldWrite).toEqual([
      'wiki/topics/_registry.md',
      'registry.json',
      'wiki/sources/a.md',
      'wiki/sources/b.md',
      'wiki/topics/t.md',
      'index.md',
      'graph.json',
    ]);
    expect(ctx.report!.orphanSources).toEqual([]);
  });

  it('re-ranks in memory without writing, so the graph still reflects the run', async () => {
    source('a');
    topic('t', { members: [{ name: 'a' }] });
    const ctx = makeCtx({ dryRun: true });
    await drain([scanVault(vault), rankTopicMembers(vault), exportGraph(vault)], ctx);
    expect(ctx.writes!.written).toEqual([]);
    expect(ctx.stats.graphNodes).toBe(2);
  });
});

describe('commit-lint', () => {
  it('stages only pathspecs that exist', async () => {
    source('a');
    writeFileSync(join(dir, 'log.md'), '# Log\n');
    const calls: Array<{ message: string; pathspecs: string[] }> = [];
    const git = {
      commit: async (message: string, pathspecs: string[]) => {
        calls.push({ message, pathspecs });
        return { committed: true, sha: 'abc1234def' };
      },
    } as unknown as GitOps;

    const ctx = makeCtx();
    await drain([scanVault(vault), regenRegistry(vault), commitLint(git, vault)], ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathspecs).toEqual(['wiki/', 'registry.json', 'log.md']);
    // lint never writes CLAUDE.md — staging it would sweep unrelated operator
    // edits into a lint commit.
    expect(LINT_PATHSPECS).not.toContain('CLAUDE.md');
  });

  it('is a no-op when nothing was written, and in dry-run', async () => {
    source('a');
    let called = 0;
    const git = {
      commit: async () => {
        called++;
        return { committed: false };
      },
    } as unknown as GitOps;

    await drain([scanVault(vault), commitLint(git, vault)], makeCtx());
    await drain([scanVault(vault), regenRegistry(vault), commitLint(git, vault)], makeCtx({ dryRun: true }));
    expect(called).toBe(0);
  });
});

describe('full pass ordering', () => {
  it('leaves the vault byte-stable after a second full run', async () => {
    source('a', { cites: ['b'], body: 'See [[wiki/sources/b]].' });
    source('b', { collected: '2026-06-01' });
    source('c', { collected: '2026-07-15' });
    const landed = arxivSource('2605.03823', { collected: '2026-07-02' });
    arxivSource('2607.00001', { collected: '2026-07-03', refs: ['2605.03823', '2601.09999'] });
    topic('t', {
      clusters: ['physics'],
      members: [
        { name: 'b', collected: '2026-06-01' },
        { name: 'c', collected: '2026-07-15' },
      ],
    });
    writeFileSync(join(dir, 'log.md'), '# Log\n');

    // Wiring order as src/lint.ts runs it: resolution first, so the registry,
    // the recount, the re-rank and the graph all see this run's new edges.
    const phases = () => [
      scanVault(vault),
      resolveExternalRefs(vault),
      regenRegistry(vault),
      recountCitations(vault),
      rankTopicMembers(vault),
      regenIndex(vault),
      exportGraph(vault),
      reportLint(vault),
    ];
    const first = makeCtx();
    await drain(phases(), first);
    expect(first.stats.refsResolved).toBe(1);
    expect(read(`wiki/sources/${landed}.md`)).toContain('cited_by: 1');
    const after = snapshot();
    after.delete('log.md'); // log.md grows by one entry per run, by design

    // A fresh timestamp must not defeat idempotency: the stamp is normalized
    // out of the content comparison, so an unchanged vault stays unchanged.
    const ctx = makeCtx({ generatedAt: '2026-08-03T09:00:00.000Z' });
    await drain(phases(), ctx);
    const again = snapshot();
    again.delete('log.md');

    expect(again).toEqual(after);
    // Only the log entry itself is written on a no-change run (it must be
    // committed by lint rather than ride in a later librarian commit).
    expect(ctx.writes!.written).toEqual(['log.md']);
    expect(statSync(join(dir, 'graph.json')).isFile()).toBe(true);
  });
});

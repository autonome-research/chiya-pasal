import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  applyFixes,
  findExtensionlessFiles,
  planFixes,
  twinCandidates,
} from '../scripts/fix-extensionless-pages.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-extensionless-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function page(title: string): string {
  return `---\ntype: topic\nupdated: 2026-07-01\n---\n\n# ${title}\n\nA definition.\n`;
}

describe('findExtensionlessFiles', () => {
  it('finds extensionless files at any depth and ignores everything else', () => {
    write('wiki/entities/higgs-boson', page('Higgs'));
    write('wiki/topics/ai-ml/agent-memory', page('Agent memory'));
    write('wiki/topics/agent-memory.md', page('Agent memory'));
    write('wiki/sources/arxiv-2605.03823', page('dotted name, left alone'));
    write('wiki/.gitkeep', '');

    const found = findExtensionlessFiles(join(dir, 'wiki'));
    expect(found).toEqual([
      join(dir, 'wiki/entities/higgs-boson'),
      join(dir, 'wiki/topics/ai-ml/agent-memory'),
    ]);
  });

  it('returns empty for a vault with no wiki dir', () => {
    expect(findExtensionlessFiles(join(dir, 'wiki'))).toEqual([]);
  });
});

describe('twinCandidates', () => {
  it('offers the sibling .md for a non-topic page', () => {
    const p = join(dir, 'wiki/entities/higgs-boson');
    expect(twinCandidates(dir, p)).toEqual([`${p}.md`]);
  });

  it('also offers the canonical flat topic page for a nested topic', () => {
    const p = join(dir, 'wiki/topics/ai-ml/agent-memory');
    expect(twinCandidates(dir, p)).toEqual([
      `${p}.md`,
      join(dir, 'wiki/topics/agent-memory.md'),
    ]);
  });

  it('does not offer itself for an already-flat topic', () => {
    const p = join(dir, 'wiki/topics/agent-memory');
    expect(twinCandidates(dir, p)).toEqual([`${p}.md`]);
  });
});

describe('planFixes', () => {
  it('renames a page with no twin', () => {
    write('wiki/entities/higgs-boson', page('Higgs'));
    const plans = planFixes(dir);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.outcome).toBe('rename');
    expect(plans[0]!.target).toBe(join(dir, 'wiki/entities/higgs-boson.md'));
    expect(plans[0]!.nestedTopic).toBe(false);
  });

  it('deletes the extensionless file when the twin is byte-identical', () => {
    const text = page('Pursuit');
    write('wiki/entities/pursuit', text);
    write('wiki/entities/pursuit.md', text);
    const plans = planFixes(dir);
    expect(plans[0]!.outcome).toBe('delete-duplicate');
    expect(plans[0]!.twin).toBe(join(dir, 'wiki/entities/pursuit.md'));
  });

  it('reports only when the twin differs', () => {
    write('wiki/entities/pursuit', page('Pursuit'));
    write('wiki/entities/pursuit.md', page('Pursuit') + '\nExtra paragraph the twin has.\n');
    const plans = planFixes(dir);
    expect(plans[0]!.outcome).toBe('conflict');
  });

  it('treats a whitespace difference as differing, not identical', () => {
    write('wiki/entities/pursuit', page('Pursuit'));
    write('wiki/entities/pursuit.md', page('Pursuit') + '\n');
    expect(planFixes(dir)[0]!.outcome).toBe('conflict');
  });

  it('sees the canonical flat topic page as the twin of a nested topic', () => {
    const text = page('Agent memory');
    write('wiki/topics/ai-ml/agent-memory', text);
    write('wiki/topics/agent-memory.md', text);
    expect(planFixes(dir)[0]!.outcome).toBe('delete-duplicate');
  });

  it('flags a nested-topic rename so the operator knows it stays scan-invisible', () => {
    write('wiki/topics/ai-ml/only-nested', page('Only nested'));
    const plan = planFixes(dir)[0]!;
    expect(plan.outcome).toBe('rename');
    expect(plan.nestedTopic).toBe(true);
  });
});

describe('applyFixes', () => {
  it('renames, deletes duplicates, and leaves conflicts alone', () => {
    write('wiki/entities/higgs-boson', page('Higgs'));
    const dup = page('Pursuit');
    write('wiki/entities/pursuit', dup);
    write('wiki/entities/pursuit.md', dup);
    write('wiki/entities/baikal-gvd', page('Baikal'));
    write('wiki/entities/baikal-gvd.md', page('Baikal (edited by hand)'));

    const result = applyFixes(planFixes(dir));
    expect(result).toEqual({ renamed: 1, deleted: 1, skipped: 0 });

    expect(existsSync(join(dir, 'wiki/entities/higgs-boson'))).toBe(false);
    expect(readFileSync(join(dir, 'wiki/entities/higgs-boson.md'), 'utf8')).toBe(page('Higgs'));
    expect(existsSync(join(dir, 'wiki/entities/pursuit'))).toBe(false);
    expect(readFileSync(join(dir, 'wiki/entities/pursuit.md'), 'utf8')).toBe(dup);
    // Conflict: BOTH files survive untouched.
    expect(readFileSync(join(dir, 'wiki/entities/baikal-gvd'), 'utf8')).toBe(page('Baikal'));
    expect(readFileSync(join(dir, 'wiki/entities/baikal-gvd.md'), 'utf8')).toBe(
      page('Baikal (edited by hand)'),
    );
  });

  it('renames byte-for-byte — the rename is not a rewrite', () => {
    const text = '---\nno trailing newline and é unicode\n---\n\n# Odd';
    write('wiki/entities/odd-page', text);
    applyFixes(planFixes(dir));
    expect(readFileSync(join(dir, 'wiki/entities/odd-page.md'), 'utf8')).toBe(text);
  });

  it('dry run (planning without applying) touches nothing', () => {
    write('wiki/entities/higgs-boson', page('Higgs'));
    const dup = page('Pursuit');
    write('wiki/entities/pursuit', dup);
    write('wiki/entities/pursuit.md', dup);

    const plans = planFixes(dir);
    expect(plans.map((p) => p.outcome).sort()).toEqual(['delete-duplicate', 'rename']);
    expect(existsSync(join(dir, 'wiki/entities/higgs-boson'))).toBe(true);
    expect(existsSync(join(dir, 'wiki/entities/higgs-boson.md'))).toBe(false);
    expect(existsSync(join(dir, 'wiki/entities/pursuit'))).toBe(true);
  });

  it('is idempotent — a second pass finds only the conflicts and changes nothing', () => {
    write('wiki/entities/higgs-boson', page('Higgs'));
    const dup = page('Pursuit');
    write('wiki/entities/pursuit', dup);
    write('wiki/entities/pursuit.md', dup);
    write('wiki/entities/baikal-gvd', page('Baikal'));
    write('wiki/entities/baikal-gvd.md', page('Baikal (edited)'));

    applyFixes(planFixes(dir));

    const second = planFixes(dir);
    expect(second.map((p) => p.outcome)).toEqual(['conflict']);
    expect(applyFixes(second)).toEqual({ renamed: 0, deleted: 0, skipped: 0 });
  });

  it('skips rather than clobbers when a twin appeared since planning', () => {
    write('wiki/entities/higgs-boson', page('Higgs'));
    const plans = planFixes(dir);
    write('wiki/entities/higgs-boson.md', page('Higgs written by the librarian meanwhile'));

    expect(applyFixes(plans)).toEqual({ renamed: 0, deleted: 0, skipped: 1 });
    expect(readFileSync(join(dir, 'wiki/entities/higgs-boson.md'), 'utf8')).toBe(
      page('Higgs written by the librarian meanwhile'),
    );
  });

  it('skips a delete whose twin diverged since planning', () => {
    const text = page('Pursuit');
    write('wiki/entities/pursuit', text);
    write('wiki/entities/pursuit.md', text);
    const plans = planFixes(dir);
    writeFileSync(join(dir, 'wiki/entities/pursuit.md'), page('Pursuit, since edited'));

    expect(applyFixes(plans)).toEqual({ renamed: 0, deleted: 0, skipped: 1 });
    expect(existsSync(join(dir, 'wiki/entities/pursuit'))).toBe(true);
  });
});

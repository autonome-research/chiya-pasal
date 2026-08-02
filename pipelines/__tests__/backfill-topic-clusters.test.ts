import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  recoverClustersFromLog,
  readTopicAddLog,
  injectClusters,
  planBackfill,
  applyBackfill,
} from '../scripts/backfill-topic-clusters.js';

// ---- fixture vault: a real git repo, since the recovery signal IS git history

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function page(slug: string, clusters?: string[]): string {
  const fm = ['---', 'type: topic', 'status: active', 'created: 2026-01-01', 'updated: 2026-07-01'];
  if (clusters) fm.push(`clusters: [${clusters.join(', ')}]`);
  fm.push('related_topics: []', '---');
  return `${fm.join('\n')}\n\n# ${slug}\n\nA definition.\n\n## Member sources\n\n_None yet._\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-backfill-clusters-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Commit topic pages under their original nested domain dirs, then flatten. */
function seedNestedThenFlatten(entries: Array<{ domain: string; slug: string }>): void {
  for (const { domain, slug } of entries) {
    mkdirSync(join(dir, 'wiki/topics', domain), { recursive: true });
    writeFileSync(join(dir, 'wiki/topics', domain, `${slug}.md`), page(slug));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'add nested topic pages');

  for (const { domain, slug } of entries) {
    git('mv', `wiki/topics/${domain}/${slug}.md`, `wiki/topics/${slug}.md`);
  }
  git('commit', '-q', '-m', 'flatten topic pages');
}

describe('recoverClustersFromLog', () => {
  it('maps a slug back to its nested domain', () => {
    const log = 'wiki/topics/ai-ml/agent-memory.md\nwiki/topics/physics/quantum-sensing.md\n';
    const out = recoverClustersFromLog(log);
    expect(out.get('agent-memory')?.clusters).toEqual(['ai-ml']);
    expect(out.get('quantum-sensing')?.clusters).toEqual(['physics']);
  });

  it('ignores paths that were already flat', () => {
    const out = recoverClustersFromLog('wiki/topics/agent-memory.md\n');
    expect(out.size).toBe(0);
  });

  it('ignores paths outside wiki/topics', () => {
    const out = recoverClustersFromLog('wiki/sources/ai-ml/arxiv-1.md\nlog.md\n');
    expect(out.size).toBe(0);
  });

  it('recovers extensionless historical paths', () => {
    const out = recoverClustersFromLog('wiki/topics/ai-ml/acsac\n');
    expect(out.get('acsac')?.clusters).toEqual(['ai-ml']);
  });

  it('keeps every intermediate directory as a cluster for deeper nesting', () => {
    const out = recoverClustersFromLog('wiki/topics/physics/computational-physics/koopman.md\n');
    expect(out.get('koopman')?.clusters).toEqual(['physics', 'computational-physics']);
  });

  it('picks the most-attested domain when a slug lived in several', () => {
    const log = [
      'wiki/topics/physics/foo.md',
      'wiki/topics/ai-ml/foo.md',
      'wiki/topics/physics/foo.md',
    ].join('\n');
    const out = recoverClustersFromLog(log);
    expect(out.get('foo')?.clusters).toEqual(['physics']);
    expect(out.get('foo')?.votes).toBe(2);
  });

  it('breaks vote ties lexicographically so runs agree', () => {
    const log = 'wiki/topics/zebra/foo.md\nwiki/topics/alpha/foo.md\n';
    expect(recoverClustersFromLog(log).get('foo')?.clusters).toEqual(['alpha']);
  });

  it('skips generated pages', () => {
    expect(recoverClustersFromLog('wiki/topics/ai-ml/_registry.md\n').size).toBe(0);
  });

  it('tolerates blank lines and commit-format noise', () => {
    expect(recoverClustersFromLog('\n\n  \nwiki/topics/ai-ml/a.md\n\n').size).toBe(1);
  });
});

describe('readTopicAddLog', () => {
  it('recovers clusters from a real git repo whose pages were git mv-ed flat', () => {
    seedNestedThenFlatten([
      { domain: 'ai-ml', slug: 'agent-memory' },
      { domain: 'physics', slug: 'quantum-sensing' },
    ]);
    const recovered = recoverClustersFromLog(readTopicAddLog(dir));
    expect(recovered.get('agent-memory')?.clusters).toEqual(['ai-ml']);
    expect(recovered.get('quantum-sensing')?.clusters).toEqual(['physics']);
  });

  it('finds nothing for a page that was always flat', () => {
    mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
    writeFileSync(join(dir, 'wiki/topics/born-flat.md'), page('born-flat'));
    git('add', '-A');
    git('commit', '-q', '-m', 'add flat topic');
    expect(recoverClustersFromLog(readTopicAddLog(dir)).has('born-flat')).toBe(false);
  });
});

describe('injectClusters', () => {
  it('inserts the key into existing frontmatter and preserves the body byte-for-byte', () => {
    const before = page('foo');
    const after = injectClusters(before, ['ai-ml']);
    expect(after).toContain('clusters: [ai-ml]');
    const body = (t: string) => t.slice(t.indexOf('\n---', 4) + 4);
    expect(body(after)).toBe(body(before));
  });

  it('places clusters directly before related_topics', () => {
    const after = injectClusters(page('foo'), ['ai-ml']);
    const lines = after.split('\n');
    expect(lines[lines.indexOf('related_topics: []') - 1]).toBe('clusters: [ai-ml]');
  });

  it('appends to the end of frontmatter when related_topics is absent', () => {
    const before = '---\ntype: topic\nupdated: 2026-07-01\n---\n\n# Foo\n\nBody.\n';
    expect(injectClusters(before, ['physics'])).toBe(
      '---\ntype: topic\nupdated: 2026-07-01\nclusters: [physics]\n---\n\n# Foo\n\nBody.\n',
    );
  });

  it('creates a frontmatter block when the page has none, keeping the body intact', () => {
    const before = '# Legacy page\n\nSome prose.\n';
    expect(injectClusters(before, ['biology'])).toBe(
      '---\nclusters: [biology]\n---\n\n# Legacy page\n\nSome prose.\n',
    );
  });

  it('leaves a page that already has clusters unchanged', () => {
    const before = page('foo', ['materials']);
    expect(injectClusters(before, ['ai-ml'])).toBe(before);
  });

  it('writes multi-part clusters as an inline array', () => {
    expect(injectClusters(page('foo'), ['physics', 'computational-physics'])).toContain(
      'clusters: [physics, computational-physics]',
    );
  });

  it('is a no-op for an empty cluster list', () => {
    const before = page('foo');
    expect(injectClusters(before, [])).toBe(before);
  });

  it('refuses to touch a page with unterminated frontmatter', () => {
    const before = '---\ntype: topic\n\n# Foo\n';
    expect(injectClusters(before, ['ai-ml'])).toBe(before);
  });
});

describe('planBackfill', () => {
  it('classifies recoverable, already-clustered and unrecoverable pages', () => {
    mkdirSync(join(dir, 'wiki/topics'), { recursive: true });
    writeFileSync(join(dir, 'wiki/topics/agent-memory.md'), page('agent-memory'));
    writeFileSync(join(dir, 'wiki/topics/already.md'), page('already', ['materials']));
    writeFileSync(join(dir, 'wiki/topics/born-flat.md'), page('born-flat'));
    writeFileSync(join(dir, 'wiki/topics/_registry.md'), '# Topic registry\n');

    const recovered = recoverClustersFromLog('wiki/topics/ai-ml/agent-memory.md\n');
    const plans = planBackfill(dir, recovered);

    expect(plans.map((p) => p.slug)).toEqual(['agent-memory', 'already', 'born-flat']);
    expect(plans.map((p) => p.outcome)).toEqual([
      'recovered',
      'already-clustered',
      'unrecoverable',
    ]);
    expect(plans[0]!.clusters).toEqual(['ai-ml']);
  });
});

describe('applyBackfill', () => {
  it('writes clusters onto recoverable pages only', () => {
    seedNestedThenFlatten([{ domain: 'ai-ml', slug: 'agent-memory' }]);
    writeFileSync(join(dir, 'wiki/topics/born-flat.md'), page('born-flat'));

    const plans = planBackfill(dir, recoverClustersFromLog(readTopicAddLog(dir)));
    expect(applyBackfill(plans)).toBe(1);

    expect(readFileSync(join(dir, 'wiki/topics/agent-memory.md'), 'utf8')).toContain(
      'clusters: [ai-ml]',
    );
    expect(readFileSync(join(dir, 'wiki/topics/born-flat.md'), 'utf8')).toBe(page('born-flat'));
  });

  it('is idempotent — a second pass writes nothing', () => {
    seedNestedThenFlatten([{ domain: 'ai-ml', slug: 'agent-memory' }]);
    const recovered = recoverClustersFromLog(readTopicAddLog(dir));
    expect(applyBackfill(planBackfill(dir, recovered))).toBe(1);
    expect(applyBackfill(planBackfill(dir, recovered))).toBe(0);
  });

  it('leaves the page body untouched', () => {
    seedNestedThenFlatten([{ domain: 'physics', slug: 'quantum-sensing' }]);
    const before = readFileSync(join(dir, 'wiki/topics/quantum-sensing.md'), 'utf8');
    applyBackfill(planBackfill(dir, recoverClustersFromLog(readTopicAddLog(dir))));
    const after = readFileSync(join(dir, 'wiki/topics/quantum-sensing.md'), 'utf8');
    const body = (t: string) => t.slice(t.indexOf('\n---', 4) + 4);
    expect(body(after)).toBe(body(before));
    expect(after).toContain('clusters: [physics]');
  });

  it('dry run (planning without applying) touches no file and no git state', () => {
    seedNestedThenFlatten([{ domain: 'ai-ml', slug: 'agent-memory' }]);
    const beforeText = readFileSync(join(dir, 'wiki/topics/agent-memory.md'), 'utf8');
    const beforeHead = git('rev-parse', 'HEAD').trim();

    const plans = planBackfill(dir, recoverClustersFromLog(readTopicAddLog(dir)));
    expect(plans.filter((p) => p.outcome === 'recovered')).toHaveLength(1);

    expect(readFileSync(join(dir, 'wiki/topics/agent-memory.md'), 'utf8')).toBe(beforeText);
    expect(git('rev-parse', 'HEAD').trim()).toBe(beforeHead);
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('leaves git untouched even in execute mode — committing stays the operator call', () => {
    seedNestedThenFlatten([{ domain: 'ai-ml', slug: 'agent-memory' }]);
    const beforeHead = git('rev-parse', 'HEAD').trim();
    applyBackfill(planBackfill(dir, recoverClustersFromLog(readTopicAddLog(dir))));
    expect(git('rev-parse', 'HEAD').trim()).toBe(beforeHead);
    // ' M' = modified in the working tree, nothing staged: the script never
    // ran `git add`.
    expect(git('status', '--porcelain')).toBe(' M wiki/topics/agent-memory.md\n');
  });
});

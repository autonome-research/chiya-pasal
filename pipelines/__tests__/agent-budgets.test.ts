/**
 * Guards for src/shared/agent-budgets.ts.
 *
 * The failure class this file exists to stop: a maxTokens constant tuned for
 * one dependency state, the dependency changes, the constant is silently
 * wrong. Nothing throws — finishReason turns 'length' and data quality
 * degrades for weeks (digest classify force-skipping EVERY article after the
 * qwen3 switch; 31 reviewer articles deferred on 'truncated' in one evening
 * once Phase A added a 6k-char vocabulary to the prompt).
 *
 * Two halves:
 *   1. the budgets themselves resolve correctly (override, garbage, floor),
 *      and the values the refactor was supposed to preserve are preserved;
 *   2. THE GUARD — no agent call site may carry a bare numeric maxTokens
 *      literal again. The file list is derived by globbing src/ and scripts/,
 *      not hand-listed, so a NEW agent file is covered the day it lands.
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { globSync } from 'glob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_BUDGETS,
  CITE_TRACKER_MAX_TOKENS,
  CLUSTER_BACKFILL_MAX_TOKENS,
  DIGEST_CLASSIFY_MAX_TOKENS,
  DIGEST_DRAFT_LADDER,
  DIGEST_DRAFT_MAX_TOKENS,
  ENTITY_SCOUT_MAX_TOKENS,
  FAST_MAX_TOKENS,
  REVIEWER_MAX_TOKENS,
  ROUTER_MAX_TOKENS,
  SHARED_SUMMARIZE_MAX_TOKENS,
  SOURCE_SCOUT_MAX_TOKENS,
  TOPIC_SCOUT_MAX_TOKENS,
  overriddenBudgets,
  resolveBudget,
  type AgentRole,
} from '../src/shared/agent-budgets.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGETS_MODULE = 'src/shared/agent-budgets.ts';

// ---------------------------------------------------------------------------
// 1a. resolution semantics
// ---------------------------------------------------------------------------

describe('resolveBudget', () => {
  it('uses the compiled-in fallback when the env var is absent', () => {
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, {})).toBe(4000);
  });

  it('honours a numeric env override above the floor', () => {
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '12000' })).toBe(
      12000,
    );
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '300' })).toBe(300);
  });

  it('clamps an override below the floor rather than honouring it', () => {
    // A typo'd env var must not be able to reintroduce the truncation bug.
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '10' })).toBe(256);
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '-5' })).toBe(256);
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '0' })).toBe(4000);
  });

  it('falls back on garbage or empty rather than resolving to NaN', () => {
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: 'lots' })).toBe(
      4000,
    );
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '' })).toBe(4000);
    expect(resolveBudget('CHIYA_X_MAX_TOKENS', 4000, 256, { CHIYA_X_MAX_TOKENS: '  ' })).toBe(4000);
  });

  it('matches the inline Math.max expressions it replaced, for every registered budget', () => {
    // Bit-identity check: this refactor must not have retuned anything.
    for (const b of Object.values(AGENT_BUDGETS)) {
      const inline = Math.max(b.floor, Number(undefined ?? String(b.fallback)) || b.fallback);
      expect(resolveBudget(b.envVar, b.fallback, b.floor, {})).toBe(inline);
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. preserved values + env back-compat (fresh module per env)
// ---------------------------------------------------------------------------

const BUDGET_ENV_VARS = [
  ...Object.values(AGENT_BUDGETS).map((b) => b.envVar),
  'CHIYA_FAST_MAX_TOKENS',
];

type BudgetsModule = typeof import('../src/shared/agent-budgets.js');

/** Import a fresh copy of the module under an exact env. Budgets are resolved
 *  at module load, so this is the only way to exercise the real consts. */
async function loadBudgets(env: Record<string, string> = {}): Promise<BudgetsModule> {
  for (const key of BUDGET_ENV_VARS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  return (await import('../src/shared/agent-budgets.js')) as BudgetsModule;
}

describe('agent budget values', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of BUDGET_ENV_VARS) saved.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it('preserves the exact effective values the call sites had before the refactor', async () => {
    const b = await loadBudgets();
    expect({
      reviewer: b.REVIEWER_MAX_TOKENS,
      router: b.ROUTER_MAX_TOKENS,
      topicScout: b.TOPIC_SCOUT_MAX_TOKENS,
      sourceScout: b.SOURCE_SCOUT_MAX_TOKENS,
      entityScout: b.ENTITY_SCOUT_MAX_TOKENS,
      citeTracker: b.CITE_TRACKER_MAX_TOKENS,
      digestClassify: b.DIGEST_CLASSIFY_MAX_TOKENS,
      digestDraft: b.DIGEST_DRAFT_MAX_TOKENS,
      sharedSummarize: b.SHARED_SUMMARIZE_MAX_TOKENS,
      clusterBackfill: b.CLUSTER_BACKFILL_MAX_TOKENS,
      fastAlias: b.FAST_MAX_TOKENS,
    }).toEqual({
      reviewer: 5000,
      router: 800,
      topicScout: 2000,
      sourceScout: 2000,
      entityScout: 2000,
      citeTracker: 2000,
      digestClassify: 4000,
      // Deliberately retuned above its pre-refactor 4000: the truncation
      // audit measured draft-sections hitting the ceiling in 75% of runs,
      // surviving only on the retry ladder. Every other value is untouched.
      digestDraft: 8000,
      sharedSummarize: 8000,
      clusterBackfill: 6000,
      fastAlias: 4000,
    });
  });

  it('keeps the draft escalation ladder at budget then double', async () => {
    const b = await loadBudgets();
    expect([...b.DIGEST_DRAFT_LADDER]).toEqual([8000, 16000]);
    const doubled = await loadBudgets({ CHIYA_DIGEST_DRAFT_MAX_TOKENS: '3000' });
    expect([...doubled.DIGEST_DRAFT_LADDER]).toEqual([3000, 6000]);
  });

  it('keeps the pre-existing CHIYA_FAST_MAX_TOKENS env name working', async () => {
    // Incident 1's fix shipped this name; the refactor must not break it.
    const b = await loadBudgets({ CHIYA_FAST_MAX_TOKENS: '9000' });
    expect(b.FAST_MAX_TOKENS).toBe(9000);
    expect(b.DIGEST_CLASSIFY_MAX_TOKENS).toBe(9000);
    expect(b.DIGEST_DRAFT_MAX_TOKENS).toBe(9000);
  });

  it('keeps the pre-existing CHIYA_REVIEWER_MAX_TOKENS env name working', async () => {
    // Incident 2's fix shipped this name.
    const b = await loadBudgets({ CHIYA_REVIEWER_MAX_TOKENS: '11000' });
    expect(b.REVIEWER_MAX_TOKENS).toBe(11000);
    expect(b.AGENT_BUDGETS.reviewer.value).toBe(11000);
  });

  it('lets a per-role digest override split classify from draft', async () => {
    const b = await loadBudgets({
      CHIYA_FAST_MAX_TOKENS: '5000',
      CHIYA_DIGEST_DRAFT_MAX_TOKENS: '7000',
    });
    expect(b.DIGEST_CLASSIFY_MAX_TOKENS).toBe(5000);
    expect(b.DIGEST_DRAFT_MAX_TOKENS).toBe(7000);
  });

  it('reports which budgets are env-overridden, for doctor', async () => {
    const b = await loadBudgets({ CHIYA_TOPIC_SCOUT_MAX_TOKENS: '3000' });
    expect(b.overriddenBudgets(process.env).map((x) => x.role)).toEqual(['topic-scout']);
    expect(b.overriddenBudgets({}).length).toBe(0);
  });
});

describe('AGENT_BUDGETS registry', () => {
  const CONSTS: Record<AgentRole, number> = {
    reviewer: REVIEWER_MAX_TOKENS,
    'librarian-router': ROUTER_MAX_TOKENS,
    'topic-scout': TOPIC_SCOUT_MAX_TOKENS,
    'source-scout': SOURCE_SCOUT_MAX_TOKENS,
    'entity-scout': ENTITY_SCOUT_MAX_TOKENS,
    'cite-tracker': CITE_TRACKER_MAX_TOKENS,
    'digest-classify': DIGEST_CLASSIFY_MAX_TOKENS,
    'digest-draft': DIGEST_DRAFT_MAX_TOKENS,
    'shared-summarize': SHARED_SUMMARIZE_MAX_TOKENS,
    'cluster-backfill': CLUSTER_BACKFILL_MAX_TOKENS,
  };

  it('carries one entry per role, matching the exported const', () => {
    for (const [role, value] of Object.entries(CONSTS)) {
      const entry = AGENT_BUDGETS[role as AgentRole];
      expect(entry, `AGENT_BUDGETS is missing role '${role}'`).toBeDefined();
      expect(entry.role).toBe(role);
      expect(entry.value).toBe(value);
    }
    expect(Object.keys(AGENT_BUDGETS).sort()).toEqual(Object.keys(CONSTS).sort());
  });

  it('gives every entry a distinct env var and a documented rationale', () => {
    const envVars = Object.values(AGENT_BUDGETS).map((b) => b.envVar);
    expect(new Set(envVars).size).toBe(envVars.length);
    for (const b of Object.values(AGENT_BUDGETS)) {
      expect(b.envVar, `${b.role} env var must follow CHIYA_*_MAX_TOKENS`).toMatch(
        /^CHIYA_[A-Z0-9_]+_MAX_TOKENS$/,
      );
      expect(b.floor, `${b.role} needs a non-zero floor`).toBeGreaterThan(0);
      expect(b.value).toBeGreaterThanOrEqual(b.floor);
      // The point of the registry: WHY, and what makes it wrong later.
      expect(b.why.length, `${b.role} has no 'why'`).toBeGreaterThan(20);
      expect(b.invalidatedBy.length, `${b.role} has no 'invalidatedBy'`).toBeGreaterThan(20);
    }
  });

  it('is unaffected by DIGEST_DRAFT_LADDER being derived', () => {
    expect(DIGEST_DRAFT_LADDER[0]).toBe(AGENT_BUDGETS['digest-draft'].value);
    expect(FAST_MAX_TOKENS).toBeGreaterThan(0);
    expect(overriddenBudgets({}).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. THE GUARD
// ---------------------------------------------------------------------------

interface SourceFile {
  /** Package-relative, POSIX separators — this is what a violation reports. */
  rel: string;
  lines: string[];
  /** Whole source with comments blanked, offsets preserved. */
  code: string;
}

/**
 * Every non-test TypeScript source in the package, minus the budgets module.
 *
 * Derived, never hand-listed: a new scout, a new digest agent, or a new
 * one-off script under scripts/ is guarded from the moment it is written,
 * which is the only version of this check worth having.
 */
function agentSourceFiles(): SourceFile[] {
  const patterns = ['src/**/*.ts', 'scripts/**/*.ts'];
  const rels = patterns
    .flatMap((p) => globSync(p, { cwd: PKG_ROOT, nodir: true, posix: true }))
    .filter((p) => p !== BUDGETS_MODULE)
    .sort();
  return [...new Set(rels)].map((rel) => {
    const raw = readFileSync(join(PKG_ROOT, rel), 'utf8');
    return { rel, lines: raw.split('\n'), code: stripComments(raw) };
  });
}

/** Line is inside a comment (block continuation, doc opener, or //). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/**
 * Blank out comments while preserving offsets, so a match maps back to its
 * real line. Per-line comment skipping missed `maxTokens:` / newline / `2500`
 * — a shape prettier emits unprompted — so the scan runs over whole sources.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Identifiers this file imports from agent-budgets.js. */
function importedBudgetIdents(src: string): Set<string> {
  const out = new Set<string>();
  const re = /import\s*(type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*agent-budgets\.js['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // A `import type {...}` line satisfies nothing at runtime — the value rule
    // below needs a real binding, so type-only imports are not counted.
    if (m[1]) continue;
    for (const part of m[2]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/**
 * `maxTokens:` and whatever it is assigned.
 *
 * camelCase only, deliberately: `maxTokens` is thread-phase's AgentConfig
 * field, so every agent call goes through it. Raw OpenAI `max_tokens` is a
 * different thing — doctor's liveness and vision probes pass tiny caps (32,
 * 256) straight to /chat/completions, and those are probe sizing, not budgets
 * any pipeline output depends on.
 */
const MAX_TOKENS_ASSIGNMENT = /\bmaxTokens\s*:\s*([^,\n}]+)/g;

/**
 * Values a call site may assign to `maxTokens`.
 *
 * Only a bare identifier imported from agent-budgets.js, or the pass-through
 * parameter literally named `maxTokens` (draft.ts's SectionAgentFn seam feeds
 * it the escalation ladder). A LOCAL const — `const MAX_TOKENS = 2000` then
 * `maxTokens: MAX_TOKENS` — is exactly the pre-refactor scout pattern this
 * guard exists to prevent, so it must NOT pass.
 */
function budgetValueViolation(expr: string, imported: Set<string>): string | null {
  const v = expr.trim().replace(/[;,)\s]+$/, '');
  if (v === 'maxTokens') return null;
  // A TYPE annotation, not an assignment: `(maxTokens: number) => …` declares
  // the pass-through seam draft.ts uses. Only value positions carry budgets.
  if (/^(number|string|boolean|any|unknown|never)\b/.test(v)) return null;
  if (/^[A-Za-z_$][\w$]*$/.test(v)) {
    return imported.has(v) ? null : `'${v}' is not imported from agent-budgets.js`;
  }
  return `'${v}' is not a budget imported from agent-budgets.js`;
}


describe('no agent call site hardcodes an output-token budget', () => {
  const files = agentSourceFiles();

  it('finds the agent sources at all (the glob itself must not silently break)', () => {
    const rels = files.map((f) => f.rel);
    // A representative slice: if globbing regresses to [], this fails loudly
    // rather than the guard below passing vacuously.
    expect(rels).toEqual(
      expect.arrayContaining([
        'src/phases/reviewer.ts',
        'src/phases/librarian-router.ts',
        'src/phases/scouts/topic-scout.ts',
        'src/phases/scouts/source-scout.ts',
        'src/phases/scouts/entity-scout.ts',
        'src/phases/scouts/cite-tracker.ts',
        'src/phases/digest/classify.ts',
        'src/phases/digest/draft.ts',
        'src/phases/shared/summarize.ts',
        'scripts/backfill-clusters-llm.ts',
      ]),
    );
    expect(rels).not.toContain('src/shared/agent-budgets.ts');
  });

  it('assigns maxTokens only from a budget imported from agent-budgets.ts', () => {
    const violations: string[] = [];
    for (const file of files) {
      const imported = importedBudgetIdents(file.code);
      MAX_TOKENS_ASSIGNMENT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MAX_TOKENS_ASSIGNMENT.exec(file.code)) !== null) {
        const why = budgetValueViolation(m[1]!, imported);
        if (why) violations.push(`${file.rel}:${lineOf(file.code, m.index)}: ${why}`);
      }
    }
    expect(
      violations,
      'Hardcoded output-token budget(s) found. A cap tuned for one model goes ' +
        'silently wrong when the model changes — that is the incident this guard ' +
        'exists for. Move each to src/shared/agent-budgets.ts (named export, ' +
        'CHIYA_<ROLE>_MAX_TOKENS override, Math.max floor, a comment saying why ' +
        'and what invalidates it) and import it here:\n  ' +
        violations.join('\n  '),
    ).toEqual([]);
  });

  it('catches the bypasses an adversarial review found (literal, line-split, local alias)', () => {
    // These three shapes ALL passed the first version of this guard. The
    // local-const alias is the pre-refactor scout pattern, i.e. the guard
    // failed to stop a regression to the exact state it was written to fix.
    const imported = new Set(['REVIEWER_MAX_TOKENS']);
    const check = (src: string): string[] => {
      const code = stripComments(src);
      const out: string[] = [];
      MAX_TOKENS_ASSIGNMENT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MAX_TOKENS_ASSIGNMENT.exec(code)) !== null) {
        const why = budgetValueViolation(m[1]!, imported);
        if (why) out.push(why);
      }
      return out;
    };

    expect(check('runAgentWithTools({ maxTokens: 2500 })')).toHaveLength(1);
    expect(check('runAgentWithTools({\n  maxTokens:\n    2500,\n})')).toHaveLength(1);
    expect(check('const MAX_TOKENS = 2000;\nfoo({ maxTokens: MAX_TOKENS })')).toHaveLength(1);
    expect(check('foo({ maxTokens: someCall() })')).toHaveLength(1);
    // …while the two legitimate shapes still pass.
    expect(check('foo({ maxTokens: REVIEWER_MAX_TOKENS })')).toEqual([]);
    expect(check('const f = (maxTokens: number) => foo({ maxTokens: maxTokens })')).toEqual([]);
    // A comment mentioning a literal is not a violation.
    expect(check('// maxTokens: 2500 was the old value\nfoo({ maxTokens: REVIEWER_MAX_TOKENS })')).toEqual([]);
  });

  it('does not accept a type-only import as satisfying the budget rule', () => {
    expect(importedBudgetIdents("import type { AgentRole } from '../shared/agent-budgets.js';").size).toBe(0);
    expect(importedBudgetIdents("import { REVIEWER_MAX_TOKENS } from '../shared/agent-budgets.js';").size).toBe(1);
  });

  it('makes every runAgentWithTools call site import its budget from the module', () => {
    const violations: string[] = [];
    for (const file of files) {
      const callIdx = file.code.indexOf('runAgentWithTools(');
      if (callIdx === -1) continue;
      const callLine = lineOf(file.code, callIdx) - 1;
      // A real binding, not merely the string appearing somewhere: a
      // type-only import would otherwise satisfy this rule at zero cost.
      const importsBudget = importedBudgetIdents(file.code).size > 0;
      if (!importsBudget) {
        violations.push(
          `${file.rel}:${callLine + 1}: calls runAgentWithTools without importing from agent-budgets.js`,
        );
      }
    }
    expect(
      violations,
      'New agent call site(s) with no budget from src/shared/agent-budgets.ts. ' +
        'Every agent needs a named, documented, env-overridable cap — an agent ' +
        'running on the adapter default is the same stale-constant failure with ' +
        'no constant to grep for:\n  ' +
        violations.join('\n  '),
    ).toEqual([]);
  });

  it('registers every agent name that reaches runAgentWithTools', () => {
    // Keeps the registry honest: doctor and operators look up a budget by the
    // agent name that appears in the JobStore event log.
    const corpus = files
      .filter((f) => f.lines.some((l) => !isComment(l) && l.includes('runAgentWithTools(')))
      .map((f) => f.lines.join('\n'))
      .join('\n');
    for (const b of Object.values(AGENT_BUDGETS)) {
      expect(
        corpus.includes(`'${b.agentName}'`) || corpus.includes(`\`${b.agentName}`),
        `AGENT_BUDGETS['${b.role}'].agentName = '${b.agentName}' matches no agent ` +
          'in the scanned sources — the registry entry is stale, or the agent was renamed.',
      ).toBe(true);
    }
  });
});

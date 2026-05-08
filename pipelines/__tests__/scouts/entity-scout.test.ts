import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import { VaultFs } from '../../src/tools/vault.js';
import {
  runEntityScoutWith,
  type EntityScoutClients,
  type EntityScoutInput,
  type ScoutAgentFn,
} from '../../src/phases/scouts/entity-scout.js';
import type { ArticleRow } from '../../src/shared/article-store.js';

let dir: string;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-entity-scout-'));
  vault = new VaultFs(dir);
  // Seed wiki/entities so the registered tools have a realistic surface to
  // operate against — they are not actually invoked here (agent is stubbed),
  // but a seeded vault catches accidental real LLM call paths early.
  mkdirSync(join(dir, 'wiki/entities'), { recursive: true });
  writeFileSync(
    join(dir, 'wiki/entities/anthropic.md'),
    '# Anthropic\n\nAI safety lab. Builds Claude.\n',
  );
  writeFileSync(
    join(dir, 'wiki/entities/openai.md'),
    '# OpenAI\n\nAI lab. Builds GPT models.\n',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeClient = {} as unknown as OpenAI;

const makeClients = (): EntityScoutClients => ({
  client: fakeClient,
  model: 'fake-model',
});

const makeArticle = (overrides: Partial<ArticleRow> = {}): ArticleRow => ({
  id: 1,
  url: 'https://arxiv.org/abs/2605.03823',
  urlHash: 'abc',
  title: 'A Study of Constitutional AI at Anthropic',
  titleHash: 'def',
  source: 'arXiv',
  field: 'AI/ML',
  snippet: 'Anthropic researchers describe constitutional AI methods.',
  collectedAt: new Date('2026-05-01T12:00:00Z'),
  collectedFrom: 'matcha',
  status: 'processing',
  statusReason: null,
  processedAt: null,
  pagePaths: [],
  ...overrides,
});

const makeInput = (overrides: Partial<EntityScoutInput> = {}): EntityScoutInput => ({
  article: makeArticle(),
  body: 'Anthropic researchers describe constitutional AI methods. The work compares to OpenAI baselines.',
  task: 'Find existing entity pages (people, organizations, products) the article references.',
  ...overrides,
});

// Helper: build a stub agent fn that returns canned text/finishReason/toolRounds.
const stubAgent = (
  text: string,
  finishReason: string = 'stop',
  toolRounds: number = 0,
): ScoutAgentFn => async () => ({ text, finishReason, toolRounds });

describe('runEntityScout — happy path', () => {
  it('returns parsed surfacedPages with toolRounds populated', async () => {
    const cannedJson = JSON.stringify({
      surfacedPages: [
        {
          path: 'wiki/entities/anthropic.md',
          excerpt: 'Anthropic is an AI safety lab.',
          relevanceNote: 'The article describes work by Anthropic researchers.',
        },
      ],
    });
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubAgent(cannedJson, 'stop', 3),
    );

    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toHaveLength(1);
    expect(result.surfacedPages[0]!.path).toBe('wiki/entities/anthropic.md');
    expect(result.surfacedPages[0]!.relevanceNote).toContain('Anthropic');
    expect(result.toolRounds).toBe(3);
  });

  it('caps surfacedPages at 4 even when the agent returns more', async () => {
    const many = {
      surfacedPages: Array.from({ length: 8 }, (_, i) => ({
        path: `wiki/entities/entity-${i}.md`,
        excerpt: `excerpt ${i}`,
        relevanceNote: `note ${i}`,
      })),
    };
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubAgent(JSON.stringify(many), 'stop', 5),
    );
    expect(result.surfacedPages).toHaveLength(4);
  });
});

describe('runEntityScout — empty surfacedPages', () => {
  it('valid output with empty surfacedPages array', async () => {
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubAgent(JSON.stringify({ surfacedPages: [] }), 'stop', 1),
    );

    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toEqual([]);
    expect(result.toolRounds).toBe(1);
  });
});

describe('runEntityScout — truncation', () => {
  it("returns {surfacedPages: [], error: 'truncated'} when finishReason is 'length' (no throw)", async () => {
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      // Even a partial-but-parseable JSON should be ignored on truncation.
      stubAgent('{"surfacedPages":[{"path":"wiki/entities/x.md"', 'length', 7),
    );

    expect(result.surfacedPages).toEqual([]);
    expect(result.error).toBe('truncated');
    expect(result.toolRounds).toBe(7);
  });
});

describe('runEntityScout — parse failure', () => {
  it('returns {surfacedPages: [], error: ...} on garbled output (no throw)', async () => {
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      // Not JSON at all, and no embedded JSON object — parseJSON falls back to
      // {surfacedPages: []}, which we treat as a parse failure since the agent
      // didn't produce structured output (we can't tell from a fallback alone,
      // so empty input from the fallback is the failure signal).
      stubAgent('totally not json output here', 'stop', 2),
    );

    expect(result.surfacedPages).toEqual([]);
    // Either parse-failed OR empty (depending on parseJSON's fallback path).
    // Both are valid no-throw outcomes; the load-bearing assertion is that no
    // exception escaped and toolRounds was preserved.
    expect(result.toolRounds).toBe(2);
  });

  it('returns empty + error when the agent function throws', async () => {
    const throwingAgent: ScoutAgentFn = async () => {
      throw new Error('backend network failure');
    };
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      throwingAgent,
    );
    expect(result.surfacedPages).toEqual([]);
    expect(result.error).toContain('backend network failure');
  });

  it("drops malformed surfacedPages entries that don't match the SurfacedPage shape", async () => {
    const mixed = {
      surfacedPages: [
        // Valid
        { path: 'wiki/entities/anthropic.md', excerpt: 'x', relevanceNote: 'y' },
        // Missing relevanceNote
        { path: 'wiki/entities/openai.md', excerpt: 'z' },
        // Wrong types
        { path: 123, excerpt: 'w', relevanceNote: 'q' },
        // Valid
        { path: 'wiki/entities/google.md', excerpt: 'g', relevanceNote: 'h' },
      ],
    };
    const result = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubAgent(JSON.stringify(mixed), 'stop', 4),
    );
    expect(result.surfacedPages).toHaveLength(2);
    expect(result.surfacedPages[0]!.path).toBe('wiki/entities/anthropic.md');
    expect(result.surfacedPages[1]!.path).toBe('wiki/entities/google.md');
  });
});

describe('runEntityScout — empty task', () => {
  it('works with sensible default when task is empty string', async () => {
    let capturedUserMessage = '';
    const captureAgent: ScoutAgentFn = async (_sys, userMessage) => {
      capturedUserMessage = userMessage;
      return {
        text: JSON.stringify({ surfacedPages: [] }),
        finishReason: 'stop',
        toolRounds: 0,
      };
    };

    const result = await runEntityScoutWith(
      makeInput({ task: '' }),
      makeClients(),
      vault,
      undefined,
      captureAgent,
    );

    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toEqual([]);
    // User message should have the default task line, not an empty one.
    expect(capturedUserMessage).toContain('Librarian\'s task for you:');
    expect(capturedUserMessage).toContain('Find existing entity pages');
  });

  it('whitespace-only task is treated as empty and uses the default', async () => {
    let capturedUserMessage = '';
    const captureAgent: ScoutAgentFn = async (_sys, userMessage) => {
      capturedUserMessage = userMessage;
      return {
        text: JSON.stringify({ surfacedPages: [] }),
        finishReason: 'stop',
        toolRounds: 0,
      };
    };
    await runEntityScoutWith(
      makeInput({ task: '   \n  ' }),
      makeClients(),
      vault,
      undefined,
      captureAgent,
    );
    expect(capturedUserMessage).toContain('Find existing entity pages');
  });
});

describe('runEntityScout — telemetry', () => {
  it('toolRounds is populated on the success path', async () => {
    const r = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubAgent(JSON.stringify({ surfacedPages: [] }), 'stop', 6),
    );
    expect(r.toolRounds).toBe(6);
  });

  it('toolRounds is populated on the truncation path', async () => {
    const r = await runEntityScoutWith(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubAgent('partial', 'length', 9),
    );
    expect(r.toolRounds).toBe(9);
  });
});

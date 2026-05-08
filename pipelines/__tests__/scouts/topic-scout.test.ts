import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import { VaultFs } from '../../src/tools/vault.js';
import {
  runTopicScoutWith,
  type ScoutAgentFn,
  type TopicScoutClients,
  type TopicScoutInput,
} from '../../src/phases/scouts/topic-scout.js';
import type { ArticleRow } from '../../src/shared/article-store.js';

let dir: string;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-topic-scout-'));
  vault = new VaultFs(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeClient = {} as unknown as OpenAI;

const makeClients = (): TopicScoutClients => ({
  client: fakeClient,
  model: 'fake-model',
});

const makeArticle = (overrides: Partial<ArticleRow> = {}): ArticleRow => ({
  id: 1,
  url: 'https://arxiv.org/abs/2605.03823',
  urlHash: 'abc',
  title: 'Bayes-Consistent Loss Functions for Healthcare AI',
  titleHash: 'def',
  source: 'arXiv',
  field: 'AI/ML',
  snippet: 'A study on Bayes consistency in clinical risk models.',
  collectedAt: new Date('2026-05-01T12:00:00Z'),
  collectedFrom: 'matcha',
  status: 'processing',
  statusReason: null,
  processedAt: null,
  pagePaths: [],
  ...overrides,
});

const makeInput = (overrides: Partial<TopicScoutInput> = {}): TopicScoutInput => ({
  article: makeArticle(),
  body: 'This paper studies Bayes-consistent loss functions in clinical risk prediction.',
  task: 'Find topic pages where this article would be at home.',
  ...overrides,
});

describe('runTopicScoutWith — happy path', () => {
  it('returns parsed surfacedPages and toolRounds', async () => {
    const agentFn: ScoutAgentFn = async () => ({
      text: JSON.stringify({
        surfacedPages: [
          {
            path: 'wiki/topics/bayes-consistency.md',
            excerpt: 'Definition of Bayes-consistent surrogate losses.',
            relevanceNote: 'Article is squarely about Bayes consistency.',
          },
          {
            path: 'wiki/topics/healthcare-ai.md',
            excerpt: 'Pages on clinical risk prediction.',
            relevanceNote: 'Application domain matches.',
          },
        ],
      }),
      finishReason: 'stop',
      toolRounds: 4,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);

    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toHaveLength(2);
    expect(result.surfacedPages[0]!.path).toBe('wiki/topics/bayes-consistency.md');
    expect(result.surfacedPages[1]!.relevanceNote).toBe('Application domain matches.');
    expect(result.toolRounds).toBe(4);
  });

  it('caps surfaced pages at 5 even if the agent returns more', async () => {
    const tooMany = Array.from({ length: 8 }, (_, i) => ({
      path: `wiki/topics/topic-${i}.md`,
      excerpt: 'excerpt',
      relevanceNote: 'note',
    }));
    const agentFn: ScoutAgentFn = async () => ({
      text: JSON.stringify({ surfacedPages: tooMany }),
      finishReason: 'stop',
      toolRounds: 1,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(result.surfacedPages).toHaveLength(5);
  });
});

describe('runTopicScoutWith — empty surfacedPages', () => {
  it('returns {surfacedPages: []} without error when nothing fits', async () => {
    const agentFn: ScoutAgentFn = async () => ({
      text: JSON.stringify({ surfacedPages: [] }),
      finishReason: 'stop',
      toolRounds: 2,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toEqual([]);
    expect(result.toolRounds).toBe(2);
  });
});

describe('runTopicScoutWith — truncation', () => {
  it('returns {surfacedPages: [], error: "truncated"} on finishReason length, does not throw', async () => {
    const agentFn: ScoutAgentFn = async () => ({
      // Even if the text would parse to surfaced pages, truncation must win.
      text: '{"surfacedPages": [{"path": "wiki/topics/foo.md", "excerpt": "x", "relevanceNote": "y"}',
      finishReason: 'length',
      toolRounds: 6,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(result.error).toBe('truncated');
    expect(result.surfacedPages).toEqual([]);
    expect(result.toolRounds).toBe(6);
  });
});

describe('runTopicScoutWith — parse failure', () => {
  it('returns parse-failed error on non-JSON output, does not throw', async () => {
    const agentFn: ScoutAgentFn = async () => ({
      text: 'I tried but I could not find anything useful.',
      finishReason: 'stop',
      toolRounds: 3,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(result.error).toBe('parse-failed');
    expect(result.surfacedPages).toEqual([]);
    expect(result.toolRounds).toBe(3);
  });

  it('returns parse-failed when surfacedPages is not an array', async () => {
    const agentFn: ScoutAgentFn = async () => ({
      text: JSON.stringify({ surfacedPages: 'not-an-array' }),
      finishReason: 'stop',
      toolRounds: 1,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(result.error).toBe('parse-failed');
    expect(result.surfacedPages).toEqual([]);
  });
});

describe('runTopicScoutWith — empty task', () => {
  it('still runs with a sensible default user message when task is empty', async () => {
    let seenUserMessage = '';
    const agentFn: ScoutAgentFn = async (_system, userMessage) => {
      seenUserMessage = userMessage;
      return {
        text: JSON.stringify({ surfacedPages: [] }),
        finishReason: 'stop',
        toolRounds: 0,
      };
    };

    const result = await runTopicScoutWith(
      makeInput({ task: '' }),
      makeClients(),
      vault,
      undefined,
      agentFn,
    );
    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toEqual([]);
    expect(seenUserMessage).toContain('Find existing topic pages relevant to this article.');
  });

  it('treats whitespace-only task as empty', async () => {
    let seenUserMessage = '';
    const agentFn: ScoutAgentFn = async (_system, userMessage) => {
      seenUserMessage = userMessage;
      return {
        text: JSON.stringify({ surfacedPages: [] }),
        finishReason: 'stop',
        toolRounds: 0,
      };
    };

    await runTopicScoutWith(
      makeInput({ task: '   \n  ' }),
      makeClients(),
      vault,
      undefined,
      agentFn,
    );
    expect(seenUserMessage).toContain('Find existing topic pages relevant to this article.');
  });
});

describe('runTopicScoutWith — tool registry exposure', () => {
  it('exposes only read-only vault tools to the agent (no vault_write)', async () => {
    let toolNames: string[] = [];
    const agentFn: ScoutAgentFn = async (_system, _user, registry) => {
      toolNames = registry.definitions().map((d) => d.name);
      return {
        text: JSON.stringify({ surfacedPages: [] }),
        finishReason: 'stop',
        toolRounds: 0,
      };
    };

    await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(toolNames).toContain('vault_read');
    expect(toolNames).toContain('vault_list');
    expect(toolNames).toContain('vault_exists');
    expect(toolNames).toContain('vault_search_by_keyword');
    expect(toolNames).not.toContain('vault_write');
  });
});

describe('runTopicScoutWith — telemetry passthrough', () => {
  it('toolRounds in the result reflects what the agent reported', async () => {
    const agentFn: ScoutAgentFn = async () => ({
      text: JSON.stringify({ surfacedPages: [] }),
      finishReason: 'stop',
      toolRounds: 7,
    });

    const result = await runTopicScoutWith(makeInput(), makeClients(), vault, undefined, agentFn);
    expect(result.toolRounds).toBe(7);
  });
});

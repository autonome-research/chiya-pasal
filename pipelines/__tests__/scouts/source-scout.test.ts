import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import { ArticleStore } from '../../src/shared/article-store.js';
import { VaultFs } from '../../src/tools/vault.js';
import {
  callSourceScoutAgent,
  runSourceScoutWith,
  type SourceScoutClients,
  type SourceScoutInput,
  type SourceScoutRunner,
} from '../../src/phases/scouts/source-scout.js';
import type { ArticleRow } from '../../src/shared/article-store.js';
import type { ScoutOutput } from '../../src/phases/scouts/types.js';

let dir: string;
let vault: VaultFs;
let store: ArticleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-scout-source-'));
  vault = new VaultFs(dir);
  store = new ArticleStore(join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const fakeClient = {} as unknown as OpenAI;
const makeClients = (): SourceScoutClients => ({ client: fakeClient, model: 'fake-model' });

const makeArticle = (overrides: Partial<ArticleRow> = {}): ArticleRow => ({
  id: 1,
  url: 'https://arxiv.org/abs/2605.03823',
  urlHash: 'abc',
  title: 'Graph Neural Networks for Molecular Property Prediction',
  titleHash: 'def',
  source: 'arXiv',
  field: 'AI/ML',
  snippet: 'A short snippet here.',
  collectedAt: new Date('2026-05-01T12:00:00Z'),
  collectedFrom: 'matcha',
  status: 'processing',
  statusReason: null,
  processedAt: null,
  pagePaths: [],
  ...overrides,
});

const makeInput = (overrides: Partial<SourceScoutInput> = {}): SourceScoutInput => ({
  article: makeArticle(),
  body: 'Body covering message-passing GNNs applied to molecular property prediction.',
  task: 'Find sibling source pages on graph neural networks for molecules.',
  ...overrides,
});

/** Build a dependency-injected SourceScoutRunner from a fixed ScoutOutput. */
const stubRunner = (output: ScoutOutput): SourceScoutRunner => async () => output;

describe('runSourceScout — happy path', () => {
  it('returns parsed surfacedPages with filenames and toolRounds', async () => {
    const stub = stubRunner({
      surfacedPages: [
        {
          path: 'wiki/sources/arxiv-2604-25099.md',
          excerpt: 'Earlier message-passing GNN for molecular property prediction.',
          relevanceNote: 'Direct prior approach using the same MPNN family.',
        },
        {
          path: 'wiki/sources/arxiv-2603-11122.md',
          excerpt: 'Graph attention on molecular graphs for QM9.',
          relevanceNote: 'Same dataset family; different architectural choice.',
        },
      ],
      toolRounds: 4,
    });

    const result = await runSourceScoutWith(makeInput(), makeClients(), vault, store, undefined, stub);

    expect(result.surfacedPages).toHaveLength(2);
    expect(result.surfacedPages[0]!.path).toBe('wiki/sources/arxiv-2604-25099.md');
    expect(result.surfacedPages[1]!.path).toBe('wiki/sources/arxiv-2603-11122.md');
    expect(result.toolRounds).toBe(4);
    expect(result.error).toBeUndefined();
  });
});

describe('runSourceScout — empty surfacedPages is valid', () => {
  it('treats no-siblings as a successful result', async () => {
    const stub = stubRunner({ surfacedPages: [], toolRounds: 1 });
    const result = await runSourceScoutWith(makeInput(), makeClients(), vault, store, undefined, stub);
    expect(result.surfacedPages).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.toolRounds).toBe(1);
  });
});

describe('runSourceScout — empty task uses sensible default', () => {
  it('still runs with empty task; the runner sees the input and returns a result', async () => {
    let observedTask: string | null = null;
    const runner: SourceScoutRunner = async (input) => {
      observedTask = input.task;
      return { surfacedPages: [], toolRounds: 0 };
    };
    const result = await runSourceScoutWith(
      makeInput({ task: '' }),
      makeClients(),
      vault,
      store,
      undefined,
      runner,
    );
    expect(observedTask).toBe('');
    expect(result.surfacedPages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// callSourceScoutAgent — exercise the real agent runner with a fake OpenAI
// client streaming canned chunks. Covers truncation, parse failure, and
// happy-path JSON output through the actual agent.
// ---------------------------------------------------------------------------

describe('callSourceScoutAgent — truncation', () => {
  it('returns {surfacedPages: [], error: "truncated"} when finish_reason=length', async () => {
    const sseStream = makeFakeStream([
      { choices: [{ delta: { content: '{"surfacedPages": [' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'length', index: 0 }] },
    ]);
    const client = {
      chat: { completions: { create: async () => sseStream } },
    } as unknown as OpenAI;

    const result = await callSourceScoutAgent(makeInput(), { client, model: 'fake-model' }, vault, store);
    expect(result.surfacedPages).toEqual([]);
    expect(result.error).toBe('truncated');
    expect(typeof result.toolRounds).toBe('number');
  });
});

describe('callSourceScoutAgent — parse failure', () => {
  it('returns {surfacedPages: [], error: "..."} on non-JSON output, does not throw', async () => {
    const sseStream = makeFakeStream([
      { choices: [{ delta: { content: 'not json at all, just prose' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ]);
    const client = {
      chat: { completions: { create: async () => sseStream } },
    } as unknown as OpenAI;

    const result = await callSourceScoutAgent(makeInput(), { client, model: 'fake-model' }, vault, store);
    expect(result.surfacedPages).toEqual([]);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

describe('callSourceScoutAgent — happy path (real agent runner, fake stream)', () => {
  it('parses surfacedPages from the model output and reports toolRounds telemetry', async () => {
    const json = JSON.stringify({
      surfacedPages: [
        {
          path: 'wiki/sources/arxiv-2604-25099.md',
          excerpt: 'Earlier MPNN paper.',
          relevanceNote: 'Same family, prior approach.',
        },
      ],
    });
    const sseStream = makeFakeStream([
      { choices: [{ delta: { content: json }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ]);
    const client = {
      chat: { completions: { create: async () => sseStream } },
    } as unknown as OpenAI;

    const result = await callSourceScoutAgent(makeInput(), { client, model: 'fake-model' }, vault, store);
    expect(result.error).toBeUndefined();
    expect(result.surfacedPages).toHaveLength(1);
    expect(result.surfacedPages[0]!.path).toBe('wiki/sources/arxiv-2604-25099.md');
    // No tools were called by the model in this stream, but the runner still
    // emits round_complete after the final assistant turn.
    expect(typeof result.toolRounds).toBe('number');
    expect(result.toolRounds).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) {
            return { value: chunks[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

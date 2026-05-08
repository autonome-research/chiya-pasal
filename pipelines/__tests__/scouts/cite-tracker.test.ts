import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import { ArticleStore, type ArticleRow } from '../../src/shared/article-store.js';
import type { ExtractedRefs } from '../../src/shared/librarian-v2-types.js';
import { VaultFs } from '../../src/tools/vault.js';
import {
  preResolveCandidates,
  runCiteTrackerWith,
  type CiteAgentFn,
  type CiteTrackerClients,
  type CiteTrackerInput,
} from '../../src/phases/scouts/cite-tracker.js';

let dir: string;
let store: ArticleStore;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-cite-'));
  store = new ArticleStore(join(dir, 'test.db'));
  vault = new VaultFs(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const fakeClient = {} as unknown as OpenAI;

const makeClients = (): CiteTrackerClients => ({
  client: fakeClient,
  model: 'fake-model',
});

const makeArticle = (overrides: Partial<ArticleRow> = {}): ArticleRow => ({
  id: 1,
  url: 'https://arxiv.org/abs/2605.03823',
  urlHash: 'abc',
  title: 'A Study of Things',
  titleHash: 'def',
  source: 'arXiv',
  field: 'AI/ML',
  snippet: 'snippet',
  collectedAt: new Date('2026-05-01T12:00:00Z'),
  collectedFrom: 'matcha',
  status: 'processing',
  statusReason: null,
  processedAt: null,
  pagePaths: [],
  ...overrides,
});

const makeRefs = (overrides: Partial<ExtractedRefs> = {}): ExtractedRefs => ({
  articleId: 1,
  arxivIds: [],
  dois: [],
  ...overrides,
});

const makeInput = (overrides: Partial<CiteTrackerInput> = {}): CiteTrackerInput => ({
  article: makeArticle(),
  body: 'The article body discusses prior work [1, 2].',
  refs: makeRefs(),
  task: '',
  ...overrides,
});

const seedRow = (title: string, url: string): void => {
  store.upsertPending({
    title,
    url,
    source: 'arXiv',
    field: 'AI/ML',
    snippet: null,
    collectedFrom: 'test.md',
  });
};

// Asserts the agent function was never called by failing if it is invoked.
const failingAgentFn: CiteAgentFn = async () => {
  throw new Error('agentFn should not be called');
};

describe('preResolveCandidates', () => {
  it('returns empty when refs has no arxivIds and no dois', () => {
    const out = preResolveCandidates(makeRefs(), makeArticle(), store);
    expect(out).toEqual([]);
  });

  it('returns empty when refs do not resolve in the store', () => {
    const refs = makeRefs({ arxivIds: ['9999.99999'], dois: ['10.9999/never'] });
    const out = preResolveCandidates(refs, makeArticle(), store);
    expect(out).toEqual([]);
  });

  it('resolves arxiv refs that exist in the store', () => {
    seedRow('Foundational Paper', 'https://arxiv.org/abs/2403.12345');
    const refs = makeRefs({ arxivIds: ['2403.12345'] });
    const out = preResolveCandidates(refs, makeArticle(), store);
    expect(out).toHaveLength(1);
    expect(out[0]!.filename).toBe('arxiv-2403-12345');
    expect(out[0]!.title).toBe('Foundational Paper');
    expect(out[0]!.refType).toBe('arxiv');
    expect(out[0]!.refValue).toBe('2403.12345');
  });

  it('resolves DOI refs that exist in the store', () => {
    seedRow('DOI Paper', 'https://doi.org/10.1038/s41586-024-12345-6');
    const refs = makeRefs({ dois: ['10.1038/s41586-024-12345-6'] });
    const out = preResolveCandidates(refs, makeArticle(), store);
    expect(out).toHaveLength(1);
    expect(out[0]!.filename).toBe('doi-10-1038-s41586-024-12345-6');
    expect(out[0]!.refType).toBe('doi');
  });

  it('skips self-cites: article URL appears in its own refs', () => {
    // The article being indexed is at arxiv 2605.03823. Seed that same row in
    // the store (it always exists — the article is being indexed). Its arxiv
    // ID appearing in its own enriched body shouldn't surface as a cite.
    seedRow('A Study of Things', 'https://arxiv.org/abs/2605.03823');
    const refs = makeRefs({ arxivIds: ['2605.03823'] });
    const out = preResolveCandidates(refs, makeArticle(), store);
    expect(out).toEqual([]);
  });
});

describe('runCiteTrackerWith — short-circuit (no LLM call)', () => {
  it('empty refs → returns empty surfacedPages without calling agentFn', async () => {
    const result = await runCiteTrackerWith(
      makeInput(),
      makeClients(),
      vault,
      store,
      undefined,
      failingAgentFn,
    );
    expect(result).toEqual({ surfacedPages: [] });
  });

  it('refs that do not resolve → returns empty without calling agentFn', async () => {
    const result = await runCiteTrackerWith(
      makeInput({ refs: makeRefs({ arxivIds: ['9999.99999'], dois: ['10.9999/never'] }) }),
      makeClients(),
      vault,
      store,
      undefined,
      failingAgentFn,
    );
    expect(result).toEqual({ surfacedPages: [] });
  });

  it('only candidate is a self-cite → empty, no LLM call', async () => {
    seedRow('A Study of Things', 'https://arxiv.org/abs/2605.03823');
    const result = await runCiteTrackerWith(
      makeInput({ refs: makeRefs({ arxivIds: ['2605.03823'] }) }),
      makeClients(),
      vault,
      store,
      undefined,
      failingAgentFn,
    );
    expect(result).toEqual({ surfacedPages: [] });
  });
});

describe('runCiteTrackerWith — happy path', () => {
  it('resolves candidates, calls agent, returns parsed surfacedPages with toolRounds', async () => {
    seedRow('Foundational Paper', 'https://arxiv.org/abs/2403.12345');
    seedRow('Comparison Paper', 'https://doi.org/10.1038/s41586-024-12345-6');

    let capturedUserMessage = '';
    const agentFn: CiteAgentFn = async (_sys, userMsg) => {
      capturedUserMessage = userMsg;
      return {
        text: JSON.stringify({
          surfacedPages: [
            {
              path: 'wiki/sources/arxiv-2403-12345.md',
              excerpt: 'Prior work establishing the framework.',
              relevanceNote: 'Foundational: the article extends this approach.',
            },
            {
              path: 'wiki/sources/doi-10-1038-s41586-024-12345-6.md',
              excerpt: 'Alternative method for the same problem.',
              relevanceNote: 'Comparison baseline in the experiments section.',
            },
          ],
        }),
        finishReason: 'stop',
        toolRounds: 4,
      };
    };

    const refs = makeRefs({
      arxivIds: ['2403.12345'],
      dois: ['10.1038/s41586-024-12345-6'],
    });
    const result = await runCiteTrackerWith(
      makeInput({ refs, task: 'Identify foundational and comparison cites.' }),
      makeClients(),
      vault,
      store,
      undefined,
      agentFn,
    );

    expect(result.surfacedPages).toHaveLength(2);
    expect(result.surfacedPages[0]!.path).toBe('wiki/sources/arxiv-2403-12345.md');
    expect(result.toolRounds).toBe(4);
    expect(result.error).toBeUndefined();
    // Sanity-check the user message includes the candidates list.
    expect(capturedUserMessage).toContain('arxiv-2403-12345');
    expect(capturedUserMessage).toContain('doi-10-1038-s41586-024-12345-6');
    expect(capturedUserMessage).toContain('Foundational Paper');
    expect(capturedUserMessage).toContain('Identify foundational and comparison cites.');
  });
});

describe('runCiteTrackerWith — failure modes', () => {
  it('finishReason: length → returns truncated error, does not throw', async () => {
    seedRow('Some Paper', 'https://arxiv.org/abs/2403.12345');
    const agentFn: CiteAgentFn = async () => ({
      text: '{"surfacedPages": [',
      finishReason: 'length',
      toolRounds: 7,
    });
    const result = await runCiteTrackerWith(
      makeInput({ refs: makeRefs({ arxivIds: ['2403.12345'] }) }),
      makeClients(),
      vault,
      store,
      undefined,
      agentFn,
    );
    expect(result).toEqual({ surfacedPages: [], error: 'truncated', toolRounds: 7 });
  });

  it('parse failure → returns error, does not throw', async () => {
    seedRow('Some Paper', 'https://arxiv.org/abs/2403.12345');
    const agentFn: CiteAgentFn = async () => ({
      text: 'this is not json at all',
      finishReason: 'stop',
      toolRounds: 3,
    });
    const result = await runCiteTrackerWith(
      makeInput({ refs: makeRefs({ arxivIds: ['2403.12345'] }) }),
      makeClients(),
      vault,
      store,
      undefined,
      agentFn,
    );
    expect(result.surfacedPages).toEqual([]);
    expect(result.error).toBeDefined();
    expect(result.toolRounds).toBe(3);
  });

  it('agent throws → returns error result, does not propagate', async () => {
    seedRow('Some Paper', 'https://arxiv.org/abs/2403.12345');
    const agentFn: CiteAgentFn = async () => {
      throw new Error('network blew up');
    };
    const result = await runCiteTrackerWith(
      makeInput({ refs: makeRefs({ arxivIds: ['2403.12345'] }) }),
      makeClients(),
      vault,
      store,
      undefined,
      agentFn,
    );
    expect(result.surfacedPages).toEqual([]);
    expect(result.error).toContain('network blew up');
  });
});

describe('runCiteTrackerWith — telemetry', () => {
  it('populates toolRounds when LLM is called', async () => {
    seedRow('Some Paper', 'https://arxiv.org/abs/2403.12345');
    const agentFn: CiteAgentFn = async () => ({
      text: JSON.stringify({ surfacedPages: [] }),
      finishReason: 'stop',
      toolRounds: 5,
    });
    const result = await runCiteTrackerWith(
      makeInput({ refs: makeRefs({ arxivIds: ['2403.12345'] }) }),
      makeClients(),
      vault,
      store,
      undefined,
      agentFn,
    );
    expect(result.toolRounds).toBe(5);
  });
});

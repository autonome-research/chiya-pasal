import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';

import { VaultFs } from '../src/tools/vault.js';
import {
  callSummary,
  writeSourceOne,
  type Summarizer,
  type WriteSourceOneClients,
  type WriteSourceOneInput,
} from '../src/phases/write-source-one.js';
import type { ArticleRow } from '../src/shared/article-store.js';

let dir: string;
let vault: VaultFs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-wso-'));
  vault = new VaultFs(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Minimal fake OpenAI client; the dependency-injected summarizer never
// actually invokes the client, so this is just a typed placeholder.
const fakeClient = {} as unknown as OpenAI;

const makeClients = (): WriteSourceOneClients => ({
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
  snippet: 'A short snippet here.',
  collectedAt: new Date('2026-05-01T12:00:00Z'),
  collectedFrom: 'matcha',
  status: 'processing',
  statusReason: null,
  processedAt: null,
  pagePaths: [],
  ...overrides,
});

const makeInput = (overrides: Partial<WriteSourceOneInput> = {}): WriteSourceOneInput => ({
  article: makeArticle(),
  body: 'A short snippet here, plus more body text.',
  topics: ['bayes-consistency', 'healthcare-ai'],
  cites: ['arxiv-2403-12834'],
  ...overrides,
});

const stubSummarizer = (text: string): Summarizer => async () => text;

describe('writeSourceOne — stable-ID skip path', () => {
  it('returns null when article has no URL; nothing written to vault', async () => {
    const input = makeInput({ article: makeArticle({ url: null }) });
    let summarizerCalled = false;
    const summarizer: Summarizer = async () => {
      summarizerCalled = true;
      return 'should not be called';
    };

    const result = await writeSourceOne(input, makeClients(), vault, undefined, summarizer);

    expect(result).toBeNull();
    expect(summarizerCalled).toBe(false);
    // No wiki/sources/ directory should have been created.
    expect(existsSync(join(dir, 'wiki/sources'))).toBe(false);
  });

  it('returns null when URL is unparseable', async () => {
    const input = makeInput({ article: makeArticle({ url: 'not a url at all' }) });
    const result = await writeSourceOne(
      input,
      makeClients(),
      vault,
      undefined,
      stubSummarizer('should not run'),
    );
    expect(result).toBeNull();
  });
});

describe('writeSourceOne — already-exists skip path', () => {
  it('returns null when target path already exists; LLM not called; file untouched', async () => {
    // Pre-create the target file with sentinel content.
    const targetPath = 'wiki/sources/arxiv-2605-03823.md';
    mkdirSync(join(dir, 'wiki/sources'), { recursive: true });
    const sentinel = '# pre-existing source page\n\ndo not overwrite\n';
    writeFileSync(join(dir, targetPath), sentinel);

    const summarizer: Summarizer = async () => {
      throw new Error('summarizer should not be called when page exists');
    };

    const result = await writeSourceOne(makeInput(), makeClients(), vault, undefined, summarizer);

    expect(result).toBeNull();
    expect(readFileSync(join(dir, targetPath), 'utf-8')).toBe(sentinel);
  });
});

describe('writeSourceOne — happy path', () => {
  it('writes the file at the expected path with valid frontmatter, H1, summary, and topic wikilinks', async () => {
    const summary = 'This paper proposes a new method.\n\nThe authors show empirical gains.';
    const result = await writeSourceOne(
      makeInput(),
      makeClients(),
      vault,
      undefined,
      stubSummarizer(summary),
    );

    expect(result).not.toBeNull();
    expect(result!.path).toBe('wiki/sources/arxiv-2605-03823.md');
    expect(result!.summary).toBe(summary);

    const written = readFileSync(join(dir, result!.path), 'utf-8');
    expect(written.startsWith('---')).toBe(true);
    expect(written).toContain('# A Study of Things');
    expect(written).toContain(summary);
    expect(written).toContain('- [[wiki/topics/bayes-consistency]]');
    expect(written).toContain('- [[wiki/topics/healthcare-ai]]');
    expect(written).toContain('- [[wiki/sources/arxiv-2403-12834]]');
    // Frontmatter has the URL and source name.
    expect(written).toContain('url: https://arxiv.org/abs/2605.03823');
    expect(written).toContain('source_name: arXiv');
    expect(written).toContain('arxiv_id: 2605.03823');
  });

  it('non-arxiv URL → url-{hash} filename, no arxiv_id frontmatter', async () => {
    const article = makeArticle({ url: 'https://example.com/some/page' });
    const result = await writeSourceOne(
      makeInput({ article }),
      makeClients(),
      vault,
      undefined,
      stubSummarizer('Some summary.'),
    );
    expect(result).not.toBeNull();
    expect(result!.path).toMatch(/^wiki\/sources\/url-[0-9a-f]{12}\.md$/);
    const written = readFileSync(join(dir, result!.path), 'utf-8');
    expect(written).not.toContain('arxiv_id:');
  });
});

describe('writeSourceOne — truncation', () => {
  it('throws an error mentioning truncation when the LLM returns finishReason: length', async () => {
    // Fake OpenAI client whose chat.completions.create returns a stream the
    // agent runner can consume, but with the final chunk's finish_reason set
    // to 'length' so callSummary detects truncation.
    const finalDelta = 'partial summary text without...';
    const sseStream = makeFakeStream([
      { choices: [{ delta: { content: finalDelta }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'length', index: 0 }] },
    ]);
    const client = {
      chat: {
        completions: {
          create: async () => sseStream,
        },
      },
    } as unknown as OpenAI;

    const input = makeInput();
    await expect(
      callSummary(input, { client, model: 'fake-model' }),
    ).rejects.toThrow(/truncated/i);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Construct an async-iterable that yields OpenAI-shaped streaming chunks.
// The agent runner consumes the stream via `for await ... of`, so any object
// implementing [Symbol.asyncIterator] suffices — we don't need a real Response.
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

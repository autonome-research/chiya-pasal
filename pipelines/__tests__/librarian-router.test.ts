import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';

import {
  runRouterWith,
  type RouterAgentFn,
  type RouterClients,
  type RouterInput,
} from '../src/phases/librarian-router.js';
import type { ArticleRow } from '../src/shared/article-store.js';

const fakeClient = {} as OpenAI;
const clients: RouterClients = { client: fakeClient, model: 'fake-model' };

function makeInput(overrides: Partial<RouterInput> = {}): RouterInput {
  const article: ArticleRow = {
    id: 1,
    url: 'https://arxiv.org/abs/2605.03823',
    urlHash: 'h',
    title: 'Realizable Bayes-Consistency for General Metric Losses',
    titleHash: 't',
    source: 'arXiv',
    field: 'AI/ML',
    snippet: 'We study Bayes-consistency in the realizable setting...',
    collectedAt: new Date('2026-05-06T00:00:00Z'),
    collectedFrom: 'raw/inbox/2026-05-06-articles.md',
    status: 'pending',
    statusReason: null,
    processedAt: null,
    pagePaths: [],
  };
  return {
    article,
    body: 'Body about realizable Bayes-consistency for general metric losses, extending PAC-Bayes bounds.',
    refs: { articleId: 1, arxivIds: [], dois: [] },
    ...overrides,
  };
}

describe('runRouterWith — happy path', () => {
  it('parses valid JSON and returns the four task strings', async () => {
    const fakeAgent: RouterAgentFn = async () => ({
      text: JSON.stringify({
        topicScoutTask: 'Look for Bayes-consistency, statistical learning theory.',
        sourceScoutTask: 'Find PAC-Bayes / consistency-proof siblings.',
        entityScoutTask: 'Check author pages.',
        citeTrackerTask: 'Distinguish foundational vs background cites.',
      }),
      finishReason: 'stop',
    });
    const out = await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(out.topicScoutTask).toContain('Bayes-consistency');
    expect(out.sourceScoutTask).toContain('PAC-Bayes');
    expect(out.entityScoutTask).toContain('author');
    expect(out.citeTrackerTask).toContain('foundational');
    expect(out.error).toBeUndefined();
  });

  it('passes the article + refs through to the user message', async () => {
    const seenMessages: string[] = [];
    const fakeAgent: RouterAgentFn = async (_sys, user) => {
      seenMessages.push(user);
      return { text: '{"topicScoutTask":"x","sourceScoutTask":"y","entityScoutTask":"z","citeTrackerTask":"w"}', finishReason: 'stop' };
    };
    await runRouterWith(
      makeInput({
        refs: { articleId: 1, arxivIds: ['2403.12345', '1804.09915'], dois: ['10.1038/s41586-024-12345-6'] },
      }),
      clients,
      undefined,
      fakeAgent,
    );
    const msg = seenMessages[0]!;
    expect(msg).toContain('Realizable Bayes-Consistency');
    expect(msg).toContain('https://arxiv.org/abs/2605.03823');
    expect(msg).toContain('arxiv: 2403.12345, 1804.09915');
    expect(msg).toContain('doi: 10.1038/s41586-024-12345-6');
  });

  it('shows "(no extracted refs)" when refs are empty', async () => {
    const seen: string[] = [];
    const fakeAgent: RouterAgentFn = async (_sys, user) => {
      seen.push(user);
      return { text: '{"topicScoutTask":"x","sourceScoutTask":"y","entityScoutTask":"z","citeTrackerTask":"w"}', finishReason: 'stop' };
    };
    await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(seen[0]!).toContain('Extracted refs: (no extracted refs)');
  });
});

describe('runRouterWith — failure modes', () => {
  it('falls back to defaults on truncation', async () => {
    const fakeAgent: RouterAgentFn = async () => ({ text: '{"topicScoutTask":"partial', finishReason: 'length' });
    const out = await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(out.error).toBe('truncated');
    expect(out.topicScoutTask).toContain('Find existing topic pages');
    expect(out.sourceScoutTask).toContain('source pages');
    expect(out.entityScoutTask).toContain('entity pages');
    expect(out.citeTrackerTask).toContain('candidate cite');
  });

  it('falls back to defaults on parse failure', async () => {
    const fakeAgent: RouterAgentFn = async () => ({ text: 'not json at all', finishReason: 'stop' });
    const out = await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(out.error).toBe('parse-failed');
    expect(out.topicScoutTask).toContain('Find existing topic pages');
  });

  it('falls back to defaults if agent throws', async () => {
    const fakeAgent: RouterAgentFn = async () => { throw new Error('boom'); };
    const out = await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(out.error).toBe('boom');
    expect(out.topicScoutTask).toContain('Find existing topic pages');
  });

  it('fills empty fields with defaults when JSON is partial', async () => {
    const fakeAgent: RouterAgentFn = async () => ({
      text: JSON.stringify({ topicScoutTask: 'real task' }), // missing the other 3
      finishReason: 'stop',
    });
    const out = await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(out.topicScoutTask).toBe('real task');
    expect(out.sourceScoutTask).toContain('source pages');
    expect(out.entityScoutTask).toContain('entity pages');
    expect(out.citeTrackerTask).toContain('candidate cite');
    expect(out.error).toBeUndefined();
  });

  it('fills whitespace-only fields with defaults', async () => {
    const fakeAgent: RouterAgentFn = async () => ({
      text: JSON.stringify({
        topicScoutTask: '  \n  ',
        sourceScoutTask: 'real',
        entityScoutTask: '',
        citeTrackerTask: 'real',
      }),
      finishReason: 'stop',
    });
    const out = await runRouterWith(makeInput(), clients, undefined, fakeAgent);
    expect(out.topicScoutTask).toContain('Find existing topic pages');
    expect(out.sourceScoutTask).toBe('real');
    expect(out.entityScoutTask).toContain('entity pages');
    expect(out.citeTrackerTask).toBe('real');
  });
});

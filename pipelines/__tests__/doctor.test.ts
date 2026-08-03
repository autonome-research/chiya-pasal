import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  doctorEnv,
  exitCodeFor,
  finishReasonOf,
  hasAssistantText,
  hasToolCall,
  probeImagePng,
  runDoctor,
  type CheckResult,
  type FetchFn,
} from '../src/doctor.js';
import { AGENT_BUDGETS } from '../src/shared/agent-budgets.js';
import type { TruncationAudit } from '../src/shared/truncation-audit.js';

describe('doctorEnv', () => {
  it('derives db path from vault dir unless THREAD_PHASE_DB is set', () => {
    const env = doctorEnv({
      VAULT_DIR: '/tmp/vault',
      CHIYA_EMAIL_TO: 'tea@example.com',
    } as NodeJS.ProcessEnv);
    expect(env.vaultDir).toBe('/tmp/vault');
    expect(env.dbPath).toBe('/tmp/vault/.chiya-pipelines.db');
    expect(env.emailTo).toBe('tea@example.com');
  });

  it('defaults to the models src/shared/env.ts actually runs', () => {
    // doctor's fallbacks drifted to gemma4 after the qwen3 switch and reported
    // health for a model nothing serves; keep these pinned to env.ts.
    const env = doctorEnv({ VAULT_DIR: '/tmp/vault' } as NodeJS.ProcessEnv);
    expect(env.fastModel).toBe('qwen36');
    expect(env.toolsModel).toBe('qwen36');
  });

  it('honors THREAD_PHASE_DB override', () => {
    const env = doctorEnv({
      VAULT_DIR: '/tmp/vault',
      THREAD_PHASE_DB: '/tmp/custom.db',
    } as NodeJS.ProcessEnv);
    expect(env.dbPath).toBe('/tmp/custom.db');
  });
});

describe('exitCodeFor', () => {
  it('returns 0 for ok/warn-only results and 1 when any check fails', () => {
    expect(exitCodeFor([{ level: 'ok', name: 'x', detail: 'ok' }])).toBe(0);
    expect(exitCodeFor([{ level: 'warn', name: 'x', detail: 'warn' }])).toBe(0);
    expect(exitCodeFor([{ level: 'fail', name: 'x', detail: 'fail' }])).toBe(1);
  });

  it('treats info and skip as non-blocking', () => {
    expect(exitCodeFor([
      { level: 'info', name: 'vision', detail: 'absent' },
      { level: 'skip', name: 'truncation', detail: 'no history' },
    ])).toBe(0);
  });
});

/** A doctor env pointed at a throwaway dir; only the checks under test matter. */
function testEnv(): ReturnType<typeof doctorEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'chiya-doctor-test-'));
  const env = doctorEnv({
    VAULT_DIR: dir,
    CHIYA_EMAIL_TO: 'tea@example.com',
    TOOLS_INFERENCE_BASE_URL: 'http://inference.test/v1',
    TOOLS_INFERENCE_MODEL: 'qwen36',
  } as NodeJS.ProcessEnv);
  rmSync(dir, { recursive: true, force: true });
  return env;
}

const cleanAudit: TruncationAudit = {
  byAgent: [{ agent: 'reviewer', unit: 'article', source: 'article-status', truncated: 3, total: 300, rate: 0.01 }],
  windowDescription: 'test window',
};

function find(results: CheckResult[], name: string): CheckResult {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`no check named ${name}`);
  return r;
}

/** Only the checks under test — vault/git/db depend on the host filesystem. */
function subset(results: CheckResult[], names: string[]): CheckResult[] {
  return results.filter((r) => names.includes(r.name));
}

describe('doctor truncation check', () => {
  it('runs under --no-network and reports a healthy rate as ok', async () => {
    const results = await runDoctor({ network: false }, testEnv(), { audit: () => cleanAudit });
    expect(find(results, 'truncation')).toMatchObject({ level: 'ok' });
    expect(find(results, 'truncation').detail).toContain('reviewer 3/300');
  });

  it('fails the run when an agent truncates at a rate that means a wrong cap', async () => {
    const audit: TruncationAudit = {
      byAgent: [{ agent: 'reviewer', unit: 'article', source: 'article-status', truncated: 31, total: 60, rate: 0.517 }],
      windowDescription: 'test window',
    };
    const results = await runDoctor({ network: false }, testEnv(), { audit: () => audit });
    expect(find(results, 'truncation')).toMatchObject({ level: 'fail' });
    expect(exitCodeFor(subset(results, ['truncation']))).toBe(1);
  });

  it('skips (never fails) when there is no history to audit', async () => {
    const audit: TruncationAudit = { byAgent: [], windowDescription: 'w', skipped: 'db has no job events yet' };
    const results = await runDoctor({ network: false }, testEnv(), { audit: () => audit });
    expect(find(results, 'truncation')).toMatchObject({ level: 'skip', detail: 'db has no job events yet' });
    expect(exitCodeFor(subset(results, ['truncation']))).toBe(0);
  });

  it('degrades to skip if the audit itself throws', async () => {
    const results = await runDoctor({ network: false }, testEnv(), {
      audit: () => { throw new Error('better-sqlite3 abi mismatch'); },
    });
    expect(find(results, 'truncation')).toMatchObject({ level: 'skip' });
    expect(find(results, 'truncation').detail).toContain('abi mismatch');
  });
});

describe('doctor budgets check', () => {
  it('lists every agent cap under --no-network so a truncation report is triageable', async () => {
    const results = await runDoctor({ network: false }, testEnv(), { audit: () => cleanAudit, processEnv: {} });
    const budgets = find(results, 'budgets');
    expect(budgets.level).toBe('ok');
    for (const b of Object.values(AGENT_BUDGETS)) {
      expect(budgets.detail).toContain(`${b.role}=${b.value}`);
    }
  });

  it('warns when a cap is env-overridden — an override outlives the reason for it', async () => {
    const results = await runDoctor({ network: false }, testEnv(), {
      audit: () => cleanAudit,
      processEnv: { CHIYA_REVIEWER_MAX_TOKENS: '5000' },
    });
    const budgets = find(results, 'budgets');
    expect(budgets.level).toBe('warn');
    expect(budgets.detail).toContain('CHIYA_REVIEWER_MAX_TOKENS');
    // A warn must never take the CLI down.
    expect(exitCodeFor(subset(results, ['budgets']))).toBe(0);
  });
});

/** Routes by URL and by what the probe body asks for; no network, no model. */
function fakeFetch(handlers: {
  models?: () => { status: number; body: unknown };
  tools?: () => { status: number; body: unknown };
  vision?: () => { status: number; body: unknown };
  throwOn?: (url: string) => boolean;
}): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    calls.push(url);
    if (handlers.throwOn?.(url)) throw new Error('fetch failed: tunnel down');
    if (url.endsWith('/models')) {
      const r = handlers.models?.() ?? { status: 200, body: { data: [{ id: 'qwen36' }] } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }
    const parsed = JSON.parse(init?.body ?? '{}') as { tools?: unknown[] };
    const r = (parsed.tools ? handlers.tools?.() : handlers.vision?.()) ?? { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

const TOOL_CALL_BODY = {
  choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'chiya_probe_lookup', arguments: '{"slug":"probe"}' } }] } }],
};
const PROSE_BODY = { choices: [{ message: { role: 'assistant', content: 'I would call chiya_probe_lookup with slug "probe".' } }] };
const VISION_BODY = { choices: [{ message: { role: 'assistant', content: 'orange checkered squares' } }] };

const CAPABILITY_CHECKS = ['tools-model', 'tool-calling', 'vision'];

describe('doctor capability probe', () => {
  it('detects a working tool-call round trip and multimodality', async () => {
    const { fetchFn } = fakeFetch({
      tools: () => ({ status: 200, body: TOOL_CALL_BODY }),
      vision: () => ({ status: 200, body: VISION_BODY }),
    });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'tools-model')).toMatchObject({ level: 'ok' });
    expect(find(results, 'tool-calling')).toMatchObject({ level: 'ok' });
    expect(find(results, 'vision')).toMatchObject({ level: 'info' });
    expect(find(results, 'vision').detail).toContain('detected');
    expect(exitCodeFor(subset(results, CAPABILITY_CHECKS))).toBe(0);
  });

  it('fails when the endpoint answers in prose instead of tool_calls (the :8000 wrapper failure)', async () => {
    const { fetchFn } = fakeFetch({
      tools: () => ({ status: 200, body: PROSE_BODY }),
      vision: () => ({ status: 200, body: VISION_BODY }),
    });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'tool-calling')).toMatchObject({ level: 'fail' });
    expect(exitCodeFor(subset(results, CAPABILITY_CHECKS))).toBe(1);
  });

  it('warns rather than fails when the tools endpoint is unreachable', async () => {
    const { fetchFn } = fakeFetch({ throwOn: (url) => url.includes('/chat/completions') });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'tool-calling')).toMatchObject({ level: 'warn' });
    expect(find(results, 'vision')).toMatchObject({ level: 'skip' });
    expect(exitCodeFor(subset(results, CAPABILITY_CHECKS))).toBe(0);
  });

  it('warns when the configured model id is not the one being served', async () => {
    const { fetchFn } = fakeFetch({
      models: () => ({ status: 200, body: { data: [{ id: 'pi-wrapper' }] } }),
      tools: () => ({ status: 200, body: TOOL_CALL_BODY }),
      vision: () => ({ status: 200, body: VISION_BODY }),
    });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'tools-model')).toMatchObject({ level: 'warn' });
    expect(find(results, 'tools-model').detail).toContain('pi-wrapper');
  });

  it('calls a truncated probe inconclusive instead of declaring tool calling absent', async () => {
    // qwen36 reasons before emitting the call; an undersized probe cap would
    // make this check commit the very failure it polices.
    const { fetchFn } = fakeFetch({
      tools: () => ({ status: 200, body: { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Okay, I need to' } }] } }),
      vision: () => ({ status: 200, body: VISION_BODY }),
    });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'tool-calling')).toMatchObject({ level: 'warn' });
    expect(find(results, 'tool-calling').detail).toContain('inconclusive');
    expect(exitCodeFor(subset(results, CAPABILITY_CHECKS))).toBe(0);
  });

  it('still reports vision detected when the image was accepted but the reply truncated', async () => {
    const { fetchFn } = fakeFetch({
      tools: () => ({ status: 200, body: TOOL_CALL_BODY }),
      vision: () => ({ status: 200, body: { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] } }),
    });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'vision').detail).toContain('detected');
    expect(find(results, 'vision').detail).toContain('finish_reason=length');
  });

  it('records absent vision as informational, never as a failure', async () => {
    const { fetchFn } = fakeFetch({
      tools: () => ({ status: 200, body: TOOL_CALL_BODY }),
      vision: () => ({ status: 400, body: { error: { message: 'this model does not support image input' } } }),
    });
    const results = await runDoctor({ network: true }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(find(results, 'vision')).toMatchObject({ level: 'info' });
    expect(find(results, 'vision').detail).toContain('absent');
    expect(exitCodeFor(subset(results, CAPABILITY_CHECKS))).toBe(0);
  });

  it('opens no sockets under --no-network but still audits truncation', async () => {
    const { fetchFn, calls } = fakeFetch({});
    const results = await runDoctor({ network: false }, testEnv(), { audit: () => cleanAudit, fetchFn });
    expect(calls).toEqual([]);
    expect(results.map((r) => r.name)).toContain('capabilities');
    expect(results.map((r) => r.name)).toContain('truncation');
    expect(results.map((r) => r.name)).not.toContain('tool-calling');
  });
});

describe('probe image', () => {
  it('is a real PNG of at least 64x64 — a 1x1 pixel crashes VL preprocessors', () => {
    const png = probeImagePng(1);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(64);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(64);
    expect(png.subarray(png.length - 8).toString('ascii')).toContain('IEND');
  });

  it('carries image structure, not a flat field', () => {
    const png = probeImagePng(64);
    expect(png.length).toBeGreaterThan(100);
  });
});

describe('response interpreters', () => {
  it('accepts only a structured tool_calls response', () => {
    expect(hasToolCall(TOOL_CALL_BODY)).toBe(true);
    expect(hasToolCall(PROSE_BODY)).toBe(false);
    expect(hasToolCall({ choices: [] })).toBe(false);
    expect(hasToolCall(null)).toBe(false);
    expect(hasToolCall({ choices: [{ message: { tool_calls: [] } }] })).toBe(false);
  });

  it('reads finish_reason so a truncated probe is never read as a verdict', () => {
    expect(finishReasonOf({ choices: [{ finish_reason: 'length' }] })).toBe('length');
    expect(finishReasonOf({ choices: [{ finish_reason: 'tool_calls' }] })).toBe('tool_calls');
    expect(finishReasonOf({ choices: [] })).toBeNull();
    expect(finishReasonOf(undefined)).toBeNull();
  });

  it('detects assistant text in string and content-part forms', () => {
    expect(hasAssistantText(VISION_BODY)).toBe(true);
    expect(hasAssistantText({ choices: [{ message: { content: [{ type: 'text', text: 'ok' }] } }] })).toBe(true);
    expect(hasAssistantText({ choices: [{ message: { content: '   ' } }] })).toBe(false);
    expect(hasAssistantText({ error: { message: 'unsupported' } })).toBe(false);
  });
});

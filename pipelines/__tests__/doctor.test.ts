import { describe, expect, it } from 'vitest';

import { doctorEnv, exitCodeFor } from '../src/doctor.js';

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
});

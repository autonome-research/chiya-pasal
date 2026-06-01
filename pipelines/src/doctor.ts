#!/usr/bin/env tsx
/** Minimal operational health check for Chiya pipelines. */

import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { access, stat } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type Level = 'ok' | 'warn' | 'fail';

interface CheckResult {
  level: Level;
  name: string;
  detail: string;
}

interface DoctorOptions {
  network: boolean;
}

interface DoctorEnv {
  vaultDir: string;
  vaultRemote: string;
  vaultBranch: string;
  dbPath: string;
  emailTo?: string;
  fastBaseUrl: string;
  fastModel: string;
  toolsBaseUrl: string;
  toolsModel: string;
}

function parseArgs(argv = process.argv.slice(2)): DoctorOptions {
  let network = true;
  for (const arg of argv) {
    if (arg === '--no-network') {
      network = false;
      continue;
    }
    throw new Error(`unknown doctor argument: ${arg}`);
  }
  return { network };
}

export function doctorEnv(env = process.env): DoctorEnv {
  const vaultDir = resolve(env.VAULT_DIR ?? `${homedir()}/vault`);
  return {
    vaultDir,
    vaultRemote: env.VAULT_REMOTE ?? 'origin',
    vaultBranch: env.VAULT_BRANCH ?? 'main',
    dbPath: env.THREAD_PHASE_DB ?? `${vaultDir}/.chiya-pipelines.db`,
    emailTo: env.CHIYA_EMAIL_TO,
    fastBaseUrl: env.FAST_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
    fastModel: env.FAST_INFERENCE_MODEL ?? 'gemma4:e4b',
    toolsBaseUrl: env.TOOLS_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
    toolsModel: env.TOOLS_INFERENCE_MODEL ?? 'gemma4:26b',
  };
}

function ok(name: string, detail: string): CheckResult { return { level: 'ok', name, detail }; }
function warn(name: string, detail: string): CheckResult { return { level: 'warn', name, detail }; }
function fail(name: string, detail: string): CheckResult { return { level: 'fail', name, detail }; }

async function checkVault(dir: string): Promise<CheckResult> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return fail('vault', `${dir} is not a directory`);
    return ok('vault', dir);
  } catch (err) {
    return fail('vault', `${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkGit(env: DoctorEnv): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', env.vaultDir, 'rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') return fail('git', 'vault is not a git work tree');
    const status = await execFileAsync('git', ['-C', env.vaultDir, 'status', '--porcelain']);
    const dirty = status.stdout.trim().length > 0;
    return dirty
      ? warn('git', `vault has uncommitted changes (${env.vaultRemote}/${env.vaultBranch})`)
      : ok('git', `clean work tree (${env.vaultRemote}/${env.vaultBranch})`);
  } catch (err) {
    return fail('git', err instanceof Error ? err.message : String(err));
  }
}

async function checkDb(path: string): Promise<CheckResult> {
  try {
    await access(path);
  } catch {
    return warn('db', `${path} does not exist yet`);
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    const article = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='article'").get();
    const job = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job'").get();
    db.close();
    if (!article || !job) return warn('db', `${path} opens, but article/job tables are incomplete`);
    return ok('db', path);
  } catch (err) {
    return fail('db', err instanceof Error ? err.message : String(err));
  }
}

async function checkInference(name: string, baseUrl: string, model: string): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: controller.signal });
    if (!res.ok) return warn(name, `${baseUrl} model=${model}: HTTP ${res.status}`);
    return ok(name, `${baseUrl} model=${model}`);
  } catch (err) {
    return warn(name, `${baseUrl} model=${model}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(options: DoctorOptions, env = doctorEnv()): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(env.emailTo ? ok('email', `CHIYA_EMAIL_TO=${env.emailTo}`) : fail('email', 'CHIYA_EMAIL_TO is not set'));
  results.push(await checkVault(env.vaultDir));
  results.push(await checkGit(env));
  results.push(await checkDb(env.dbPath));
  if (options.network) {
    results.push(await checkInference('fast-inference', env.fastBaseUrl, env.fastModel));
    results.push(await checkInference('tools-inference', env.toolsBaseUrl, env.toolsModel));
  } else {
    results.push(warn('inference', 'network checks skipped via --no-network'));
  }
  return results;
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

function symbol(level: Level): string {
  return level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
}

async function main(): Promise<void> {
  const options = parseArgs();
  const results = await runDoctor(options);
  for (const r of results) console.log(`${symbol(r.level)} ${r.name}: ${r.detail}`);
  process.exitCode = exitCodeFor(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[doctor] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

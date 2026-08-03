#!/usr/bin/env tsx
/** Minimal operational health check for Chiya pipelines. */

import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { access, stat } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { deflateSync } from 'zlib';

import { AGENT_BUDGETS, overriddenBudgets } from './shared/agent-budgets.js';
import { auditTruncation, classifyTruncationAudit, type TruncationAudit } from './shared/truncation-audit.js';

const execFileAsync = promisify(execFile);

/**
 * `skip` = not measurable here (no history, no network). `info` = measured and
 * reported, with no opinion — used for capabilities the pipeline does not
 * currently require. Neither affects the exit code; only `fail` does.
 */
export type Level = 'ok' | 'info' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
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
    // Defaults MUST track src/shared/env.ts — doctor's own fallbacks had gone
    // stale at gemma4:e4b/gemma4:26b after the qwen3 switch, so an unset env
    // made the health check report on a model nothing runs. Same class of bug
    // the truncation check exists to catch.
    fastModel: env.FAST_INFERENCE_MODEL ?? 'qwen36',
    toolsBaseUrl: env.TOOLS_INFERENCE_BASE_URL ?? 'http://localhost:11435/v1',
    toolsModel: env.TOOLS_INFERENCE_MODEL ?? 'qwen36',
  };
}

function ok(name: string, detail: string): CheckResult { return { level: 'ok', name, detail }; }
function warn(name: string, detail: string): CheckResult { return { level: 'warn', name, detail }; }
function fail(name: string, detail: string): CheckResult { return { level: 'fail', name, detail }; }
function info(name: string, detail: string): CheckResult { return { level: 'info', name, detail }; }
function skip(name: string, detail: string): CheckResult { return { level: 'skip', name, detail }; }

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

/**
 * Truncation audit — the standing check for the "stale output cap" class
 * (digest classify/draft at 800/2500, the reviewer at 2500). Pure DB reading,
 * so it runs under --no-network too: silent degradation does not need a
 * network to happen, and this is the only surface that reports it.
 */
function checkTruncation(dbPath: string, audit: (path: string) => TruncationAudit): CheckResult {
  let result: TruncationAudit;
  try {
    result = audit(dbPath);
  } catch (err) {
    // The audit already degrades to `skipped` internally; a throw here means
    // something unforeseen, and a health check must not take the CLI down.
    return skip('truncation', `audit unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const verdict = classifyTruncationAudit(result);
  return { level: verdict.level, name: 'truncation', detail: verdict.detail };
}

/**
 * The other half of the truncation check: what the caps ARE right now.
 *
 * `truncation` says an agent is hitting its ceiling; this says what that
 * ceiling is, without grepping the phases. Pure module read, so it runs under
 * --no-network. An env override is a WARN rather than ok — incident 2's fix
 * shipped as CHIYA_REVIEWER_MAX_TOKENS, so a value set in a live unit file is
 * exactly the kind of state that outlives the reason for it.
 */
function checkBudgets(env: NodeJS.ProcessEnv): CheckResult {
  const roster = Object.values(AGENT_BUDGETS)
    .map((b) => `${b.role}=${b.value}`)
    .join(' ');
  const overridden = overriddenBudgets(env);
  if (overridden.length === 0) return ok('budgets', roster);
  const detail = overridden.map((b) => `${b.envVar}=${b.value}`).join(' ');
  return warn('budgets', `env-overridden: ${detail} | defaults: ${roster}`);
}

async function checkInference(name: string, baseUrl: string, model: string, fetchFn: FetchFn): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/models`, { signal: controller.signal });
    if (!res.ok) return warn(name, `${baseUrl} model=${model}: HTTP ${res.status}`);
    return ok(name, `${baseUrl} model=${model}`);
  } catch (err) {
    return warn(name, `${baseUrl} model=${model}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------------------------------------------------------------------
 * Inference capability probe.
 *
 * The mirror image of the stale-cap class: a capability we BELIEVE the
 * endpoint has. Both directions have burned us. The PI wrapper on :8000 served
 * chat completions happily but silently dropped tool calling, so the scouts
 * confabulated page names for a week (see src/shared/env.ts). And a model's
 * multimodality was recorded as unsupported from ONE probe with a 1x1 PNG that
 * crashed the VL preprocessor — a false negative that then sat in the roadmap
 * as an infrastructure blocker.
 *
 * So: probe the behaviour the pipeline depends on, not the version string.
 * ------------------------------------------------------------------------- */

/** Local models are slow and this probe is deliberately a real round-trip;
 *  3s (the /models timeout) would report a false absence. */
const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.CHIYA_DOCTOR_PROBE_TIMEOUT_MS ?? '20000') || 20000);

/** The probe's own output cap is subject to the failure class this check
 *  exists to police: qwen36 reasons before emitting a tool call, so a thrifty
 *  cap truncates the probe and the check reports "tool calling absent" when
 *  the endpoint is fine. Hence a generous default AND explicit `length`
 *  handling below — a truncated probe is inconclusive, never a verdict. */
const PROBE_MAX_TOKENS = Math.max(64, Number(process.env.CHIYA_DOCTOR_PROBE_MAX_TOKENS ?? '1000') || 1000);

export type FetchFn = typeof fetch;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A REAL image, not a degenerate one. Minimum 64x64 with actual structure (a
 * checkerboard) because that is what the vision incident turned on: a 1x1
 * pixel PNG crashed the VL preprocessor's patch/resize path, the crash was
 * read as "model is not multimodal", and the wrong belief outlived the probe.
 * Anything that tiles into at least one full patch grid answers the real
 * question — does the endpoint accept and process an image at all.
 */
export function probeImagePng(size = 64): Buffer {
  const px = Math.max(64, size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc(px * (1 + px * 3));
  for (let y = 0; y < px; y++) {
    const rowStart = y * (1 + px * 3);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < px; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      const off = rowStart + 1 + x * 3;
      raw[off] = on ? 0xf0 : 0x20;
      raw[off + 1] = on ? 0x80 : 0x40;
      raw[off + 2] = on ? 0x30 : 0xc0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function probeImageDataUri(size = 64): string {
  return `data:image/png;base64,${probeImagePng(size).toString('base64')}`;
}

/** True when the endpoint answered with a structured tool call rather than
 *  prose about calling one. Prose is exactly what the :8000 wrapper returned. */
export function hasToolCall(body: unknown): boolean {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const calls = (choices[0] as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/** `length` here means the PROBE ran out of budget, not that the capability is
 *  missing. Never conflate the two — that conflation is incident #4. */
export function finishReasonOf(body: unknown): string | null {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const reason = (choices[0] as { finish_reason?: unknown })?.finish_reason;
  return typeof reason === 'string' ? reason : null;
}

/** True when the endpoint returned any assistant text for the image message. */
export function hasAssistantText(body: unknown): boolean {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  return typeof content === 'string' ? content.trim().length > 0 : Array.isArray(content) && content.length > 0;
}

async function postCompletion(
  env: DoctorEnv,
  body: unknown,
  fetchFn: FetchFn,
): Promise<{ status: number; body: unknown; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${env.toolsBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

/** (a) Does the configured model id actually exist on the configured endpoint?
 *  A tunnel repointed at a different server answers 200 for everything else. */
async function checkToolsModel(env: DoctorEnv, fetchFn: FetchFn): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${env.toolsBaseUrl.replace(/\/$/, '')}/models`, { signal: controller.signal });
    if (!res.ok) return warn('tools-model', `${env.toolsBaseUrl}: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id)) : [];
    if (ids.includes(env.toolsModel)) return ok('tools-model', `${env.toolsModel} served by ${env.toolsBaseUrl}`);
    return warn('tools-model', `${env.toolsModel} not listed by ${env.toolsBaseUrl}; served: ${ids.join(', ') || '(none)'}`);
  } catch (err) {
    return warn('tools-model', `${env.toolsBaseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** (b) A real tool-call round trip. The router, scouts and reviewer are all
 *  useless without it, so a 200 that answers in prose is a FAIL, not a warning
 *  — that is the exact shape of the :8000 wrapper outage. Transport failures
 *  stay warnings so a restarting tunnel does not fail the check. */
async function checkToolCalling(env: DoctorEnv, fetchFn: FetchFn): Promise<CheckResult> {
  const r = await postCompletion(
    env,
    {
      model: env.toolsModel,
      max_tokens: PROBE_MAX_TOKENS,
      temperature: 0,
      messages: [{
        role: 'user',
        content: 'Look up the vault page with slug "probe". You must use the chiya_probe_lookup tool.',
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'chiya_probe_lookup',
          description: 'Look up a vault page by slug.',
          parameters: {
            type: 'object',
            properties: { slug: { type: 'string', description: 'page slug' } },
            required: ['slug'],
          },
        },
      }],
      tool_choice: 'auto',
    },
    fetchFn,
  );
  if (r.error) return warn('tool-calling', `${env.toolsBaseUrl}: ${r.error}`);
  if (r.status !== 200) return warn('tool-calling', `${env.toolsBaseUrl} model=${env.toolsModel}: HTTP ${r.status}`);
  if (!hasToolCall(r.body) && finishReasonOf(r.body) === 'length') {
    return warn(
      'tool-calling',
      `inconclusive: probe truncated at ${PROBE_MAX_TOKENS} tokens before any tool call — raise CHIYA_DOCTOR_PROBE_MAX_TOKENS`,
    );
  }
  // An unreadable body (HTML error page served 200, proxy interstitial,
  // aborted stream) tells us nothing about tool support. Only a well-formed
  // response that lacks tool_calls earns the hard fail.
  if (r.body === null) {
    return warn(
      'tool-calling',
      `inconclusive: ${env.toolsBaseUrl} returned an unparseable body (HTTP 200) — proxy or wrapper in front of the model?`,
    );
  }
  if (!hasToolCall(r.body)) {
    return fail(
      'tool-calling',
      `${env.toolsModel} answered without tool_calls — scouts/router/reviewer would confabulate (the :8000 wrapper failure mode)`,
    );
  }
  return ok('tool-calling', `${env.toolsModel} returned tool_calls`);
}

/** (c) Multimodality, probed with a real 64x64 image. INFORMATIONAL either
 *  way: no pipeline phase sends images today, so absence is a fact to record,
 *  not a failure — and detection is how a stale "not supported" belief dies. */
async function checkVision(env: DoctorEnv, fetchFn: FetchFn): Promise<CheckResult> {
  const r = await postCompletion(
    env,
    {
      model: env.toolsModel,
      max_tokens: PROBE_MAX_TOKENS,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image in three words.' },
          { type: 'image_url', image_url: { url: probeImageDataUri(64) } },
        ],
      }],
    },
    fetchFn,
  );
  if (r.error) return skip('vision', `${env.toolsBaseUrl}: ${r.error}`);
  // The verdict hangs on whether the endpoint ACCEPTED the image, not on
  // whether text came back: a reasoning model can burn the cap and return
  // nothing while having processed the image perfectly well. Reading an empty
  // completion as "not multimodal" is how the 1x1-pixel conclusion happened.
  // 5xx is the backend having a bad moment, not a capability verdict. Calling
  // a transient 503 "not multimodal" is structurally the same mistake as the
  // 1x1-pixel probe: one bad sample hardened into a belief.
  if (r.status >= 500 || r.status === 0) {
    return info('vision', `inconclusive: ${env.toolsBaseUrl} returned HTTP ${r.status} — retry when the backend is healthy`);
  }
  if (r.status !== 200) {
    return info('vision', `absent: ${env.toolsModel} rejected a 64x64 PNG (HTTP ${r.status}) — not required by any phase today`);
  }
  const described = hasAssistantText(r.body)
    ? 'and described it'
    : `but returned no text (finish_reason=${finishReasonOf(r.body) ?? 'unknown'})`;
  return info('vision', `detected: ${env.toolsModel} accepted a 64x64 PNG ${described}`);
}

export interface DoctorDeps {
  fetchFn?: FetchFn;
  /** Injected so tests exercise doctor's wiring without a real DB. */
  audit?: (dbPath: string) => TruncationAudit;
  /** Raw process env, for the budgets check's override report. */
  processEnv?: NodeJS.ProcessEnv;
}

export async function runDoctor(
  options: DoctorOptions,
  env = doctorEnv(),
  deps: DoctorDeps = {},
): Promise<CheckResult[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const audit = deps.audit ?? ((dbPath: string) => auditTruncation(dbPath));
  const results: CheckResult[] = [];
  results.push(env.emailTo ? ok('email', `CHIYA_EMAIL_TO=${env.emailTo}`) : fail('email', 'CHIYA_EMAIL_TO is not set'));
  results.push(await checkVault(env.vaultDir));
  results.push(await checkGit(env));
  results.push(await checkDb(env.dbPath));
  results.push(checkTruncation(env.dbPath, audit));
  results.push(checkBudgets(deps.processEnv ?? process.env));
  if (options.network) {
    results.push(await checkInference('fast-inference', env.fastBaseUrl, env.fastModel, fetchFn));
    results.push(await checkInference('tools-inference', env.toolsBaseUrl, env.toolsModel, fetchFn));
    results.push(await checkToolsModel(env, fetchFn));
    results.push(await checkToolCalling(env, fetchFn));
    results.push(await checkVision(env, fetchFn));
  } else {
    results.push(warn('inference', 'network checks skipped via --no-network'));
    results.push(skip('capabilities', 'tool-calling/vision probes skipped via --no-network'));
  }
  return results;
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

function symbol(level: Level): string {
  if (level === 'ok') return '✓';
  if (level === 'warn') return '!';
  if (level === 'fail') return '✗';
  if (level === 'info') return 'i';
  return '-';
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

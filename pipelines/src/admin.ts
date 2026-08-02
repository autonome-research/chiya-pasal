#!/usr/bin/env tsx
/**
 * chiya admin CLI — tenant lifecycle management.
 *
 *   npm run admin -- users list
 *   npm run admin -- users show <handle>
 *   npm run admin -- users add --handle h --name "Name" --email a@b.c \
 *       --vault-remote git@github.com:org/vault-h.git \
 *       --interests "paragraph one" [--interests "paragraph two" ...] \
 *       [--branch main] [--threshold 0.55]
 *   npm run admin -- users pause <handle>
 *   npm run admin -- users resume <handle>
 *   npm run admin -- users remove <handle> [--purge]
 *   npm run admin -- requeue --user <handle> --status failed|skipped \
 *       [--like <pattern>] [--execute]
 *   npm run admin -- requeue-shared [--execute]
 *
 * `requeue` returns terminal rows in a user's ArticleStore to 'pending'.
 * Default is a dry-run that prints the status_reason histogram of what
 * would be requeued; --execute performs the reset.
 *
 * `requeue-shared` returns shared-cache rows that failed on TRANSIENT
 * summarize errors (connection/timeout/5xx) to their pre-summarize status
 * so the next tick retries them. Terminal failures are left alone. Same
 * dry-run-by-default contract.
 *
 * The CLI mutates config/users.yaml (comment-preserving) and manages the
 * per-user directory skeleton under CHIYA_DATA_ROOT. It does NOT create
 * GitHub repositories or clone vaults — those are deliberate manual/scripted
 * onboarding steps (see the printed next-steps after `users add`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { ArticleStore } from './shared/article-store.js';
import { envFromUser } from './shared/env.js';
import {
  isTransientFailureReason,
  SharedArticleStore,
} from './shared/shared-article-store.js';
import {
  defaultUsersConfigPath,
  loadUsersConfig,
  type User,
  type UsersConfig,
} from './shared/users.js';
import {
  addUser,
  formatReasonHistogram,
  parseRequeueArgs,
  removeUser,
  setUserEnabled,
  type NewUserInput,
} from './shared/users-admin.js';

function usersFilePath(): string {
  return defaultUsersConfigPath();
}

function dataRoot(): string {
  return resolve(process.env.CHIYA_DATA_ROOT ?? `${homedir()}/chiya-data`);
}

function readUsersFile(): string {
  const path = usersFilePath();
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function writeUsersFile(text: string): void {
  writeFileSync(usersFilePath(), text, 'utf-8');
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Argument parsing — tiny, explicit, no dependency.
// ---------------------------------------------------------------------------

interface ParsedFlags {
  positional: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const key = arg.slice(2, eq);
      const list = flags.get(key) ?? [];
      list.push(arg.slice(eq + 1));
      flags.set(key, list);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      const list = flags.get(key) ?? [];
      list.push(next);
      flags.set(key, list);
      i++;
    } else {
      booleans.add(key);
    }
  }
  return { positional, flags, booleans };
}

function requiredFlag(parsed: ParsedFlags, name: string): string {
  const values = parsed.flags.get(name);
  if (!values || values.length === 0) fail(`--${name} is required`);
  return values[values.length - 1]!;
}

// ---------------------------------------------------------------------------
// Per-user status helpers (read-only; never create DB files as a side effect)
// ---------------------------------------------------------------------------

interface UserStatus {
  queue: string;
}

function statusFor(user: User): UserStatus {
  const dbPath = join(envFromUser(user).vaultDir, '.chiya-pipelines.db');
  if (!existsSync(dbPath)) return { queue: '(no db yet)' };
  const store = new ArticleStore(dbPath);
  try {
    const c = store.countByStatus();
    return { queue: `pending=${c.pending} done=${c.done} skipped=${c.skipped} failed=${c.failed}` };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdList(): void {
  let config: UsersConfig;
  try {
    config = loadUsersConfig();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (config.users.length === 0) {
    console.log('no users configured');
    return;
  }
  for (const u of config.users) {
    const state = u.enabled ? 'enabled ' : 'PAUSED  ';
    const { queue } = statusFor(u);
    console.log(`${state} ${u.handle.padEnd(16)} ${u.emailTo.padEnd(32)} ${queue}`);
  }
}

function cmdShow(handle: string): void {
  const config = loadUsersConfig();
  const user = config.users.find((u) => u.handle === handle);
  if (!user) fail(`no user with handle '${handle}'`);
  const env = envFromUser(user);
  console.log(`handle:        ${user.handle}`);
  console.log(`name:          ${user.name}`);
  console.log(`email_to:      ${user.emailTo}`);
  console.log(`vault_remote:  ${user.vaultRemote}`);
  console.log(`vault_branch:  ${user.vaultBranch}`);
  console.log(`vault_dir:     ${env.vaultDir}`);
  console.log(`threshold:     ${user.threshold}`);
  console.log(`enabled:       ${user.enabled}`);
  console.log(`onboarded:     ${user.onboarded ?? '(unset)'}`);
  console.log(`interests:`);
  for (const p of user.interests) console.log(`  - ${p.replace(/\s+/g, ' ').trim()}`);
  console.log(`queue:         ${statusFor(user).queue}`);
}

function cmdAdd(parsed: ParsedFlags): void {
  const interests = parsed.flags.get('interests') ?? [];
  if (interests.length === 0) fail('--interests is required (repeat the flag for multiple interest areas)');

  const thresholdRaw = parsed.flags.get('threshold')?.at(-1);
  const input: NewUserInput = {
    handle: requiredFlag(parsed, 'handle'),
    name: requiredFlag(parsed, 'name'),
    emailTo: requiredFlag(parsed, 'email'),
    vaultRemote: requiredFlag(parsed, 'vault-remote'),
    vaultBranch: parsed.flags.get('branch')?.at(-1),
    interests,
    threshold: thresholdRaw !== undefined ? Number(thresholdRaw) : undefined,
    onboarded: new Date().toISOString().slice(0, 10),
  };

  writeUsersFile(addUser(readUsersFile(), input));

  const userDir = join(dataRoot(), 'users', input.handle);
  mkdirSync(join(userDir, 'vault'), { recursive: true });

  console.log(`added '${input.handle}' to ${usersFilePath()}`);
  console.log(`created ${userDir}/vault/`);
  console.log('');
  console.log('next steps:');
  console.log(`  1. create the private vault repo (once):`);
  console.log(`       gh repo create ${remoteToSlug(input.vaultRemote)} --private`);
  console.log(`  2. clone it into the server-side vault dir:`);
  console.log(`       rm -rf ${userDir}/vault && git clone ${input.vaultRemote} ${userDir}/vault`);
  console.log(`  3. seed the vault skeleton (wiki/topics, wiki/sources, log.md) and push.`);
  console.log(`  4. invite the user as a repo collaborator so they can clone it locally.`);
}

function remoteToSlug(remote: string): string {
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
  return m ? m[1]! : '<org>/<repo>';
}

function cmdSetEnabled(handle: string, enabled: boolean): void {
  writeUsersFile(setUserEnabled(readUsersFile(), handle, enabled));
  console.log(`${enabled ? 'resumed' : 'paused'} '${handle}'`);
}

function cmdRemove(handle: string, purge: boolean): void {
  writeUsersFile(removeUser(readUsersFile(), handle));
  console.log(`removed '${handle}' from ${usersFilePath()}`);
  if (purge) {
    const userDir = join(dataRoot(), 'users', handle);
    if (existsSync(userDir)) {
      const archived = `${userDir}.removed-${new Date().toISOString().slice(0, 10)}`;
      renameSync(userDir, archived);
      console.log(`archived ${userDir} → ${archived} (delete manually when certain)`);
    }
  } else {
    console.log(`server-side data left in place (use --purge to archive the user dir)`);
  }
}

// ---------------------------------------------------------------------------
// requeue — return terminal ArticleStore rows to 'pending'.
// ---------------------------------------------------------------------------

function cmdRequeue(argv: string[]): void {
  const req = parseRequeueArgs(argv);
  const config = loadUsersConfig();
  // Paused users included deliberately — requeue is data repair, and a
  // paused tenant's queue should be fixable before resuming them.
  const user = config.users.find((u) => u.handle === req.handle);
  if (!user) fail(`no user with handle '${req.handle}'`);
  const dbPath = join(envFromUser(user).vaultDir, '.chiya-pipelines.db');
  if (!existsSync(dbPath)) fail(`no ArticleStore db for '${req.handle}' at ${dbPath}`);

  const filter = {
    status: req.status,
    ...(req.likeReason !== null ? { likeReason: req.likeReason } : {}),
  };
  const store = new ArticleStore(dbPath);
  try {
    if (!req.execute) {
      const histogram = store.reasonHistogram(filter);
      const total = histogram.reduce((n, e) => n + e.count, 0);
      console.log(
        `dry-run: would requeue ${total} '${req.status}' article(s) for '${req.handle}'` +
          (req.likeReason !== null ? ` matching reason LIKE ${req.likeReason}` : ''),
      );
      for (const line of formatReasonHistogram(histogram)) console.log(line);
      if (total > 0) console.log('re-run with --execute to requeue.');
      return;
    }
    const requeued = store.requeueByStatus(filter);
    console.log(`requeued ${requeued} '${req.status}' article(s) to pending for '${req.handle}'`);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// requeue-shared — return transient-failed shared-cache rows for retry.
// ---------------------------------------------------------------------------

function cmdRequeueShared(argv: string[]): void {
  const execute = argv.includes('--execute');
  const dbPath = join(dataRoot(), 'shared', 'articles.db');
  if (!existsSync(dbPath)) fail(`no shared cache db at ${dbPath}`);

  const store = new SharedArticleStore(dbPath);
  try {
    if (!execute) {
      const failed = store.listByStatus('failed', 10_000);
      const transient = failed.filter(
        (r) => r.statusReason !== null && isTransientFailureReason(r.statusReason),
      );
      console.log(
        `dry-run: would requeue ${transient.length} of ${failed.length} failed shared article(s)` +
          ' (transient summarize errors only)',
      );
      for (const r of transient.slice(0, 20)) {
        console.log(`  ${r.stableId}  ${r.statusReason?.slice(0, 80)}`);
      }
      if (transient.length > 0) console.log('re-run with --execute to requeue.');
      return;
    }
    const requeued = store.requeueTransientFailures();
    console.log(`requeued ${requeued} transient-failed shared article(s) for retry`);
  } finally {
    store.close();
  }
}

function main(): void {
  const [domain, action, ...rest] = process.argv.slice(2);
  if (domain === 'requeue-shared') {
    try {
      return cmdRequeueShared([action, ...rest].filter((a): a is string => a !== undefined));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  if (domain === 'requeue') {
    try {
      return cmdRequeue([action, ...rest].filter((a): a is string => a !== undefined));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  if (domain !== 'users' || !action) {
    console.error(
      'Usage: admin.ts users <list|show|add|pause|resume|remove> [args]\n' +
        '       admin.ts requeue --user <handle> --status failed|skipped [--like <pattern>] [--execute]\n' +
        '       admin.ts requeue-shared [--execute]\n' +
        'See the file docstring for full flag reference.',
    );
    process.exit(2);
  }
  const parsed = parseFlags(rest);

  try {
    switch (action) {
      case 'list':
        return cmdList();
      case 'show':
        return cmdShow(parsed.positional[0] ?? fail('usage: users show <handle>'));
      case 'add':
        return cmdAdd(parsed);
      case 'pause':
        return cmdSetEnabled(parsed.positional[0] ?? fail('usage: users pause <handle>'), false);
      case 'resume':
        return cmdSetEnabled(parsed.positional[0] ?? fail('usage: users resume <handle>'), true);
      case 'remove':
        return cmdRemove(
          parsed.positional[0] ?? fail('usage: users remove <handle> [--purge]'),
          parsed.booleans.has('purge'),
        );
      default:
        fail(`unknown action 'users ${action}'`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// Run only when invoked directly, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}

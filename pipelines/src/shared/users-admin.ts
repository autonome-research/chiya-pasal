/**
 * Pure logic for the admin CLI: users.yaml mutations plus argument parsing /
 * report formatting for the requeue command.
 *
 * The YAML transforms go text → text (via the yaml package's Document API,
 * which preserves comments and key order), each validated by round-tripping
 * the result through parseUsersConfig before returning — a transform that
 * would produce an unloadable config throws instead of writing.
 *
 * File IO, directory creation, and display live in src/admin.ts; nothing
 * here touches the filesystem.
 */

import { parseDocument, YAMLSeq } from 'yaml';

import { parseUsersConfig } from './users.js';

export interface NewUserInput {
  handle: string;
  name: string;
  emailTo: string;
  vaultRemote: string;
  vaultBranch?: string;
  interests: string[];
  threshold?: number;
  /** ISO date (YYYY-MM-DD). The CLI passes today; tests pass fixtures. */
  onboarded: string;
}

const EMPTY_TEMPLATE = `# Chiya users — source of truth for the multi-tenant pipelines.
# Managed by \`npm run admin -- users ...\`; hand-edits are fine too.
# See users.yaml.example for the field reference.

users: []
`;

class UsersAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsersAdminError';
  }
}

function loadDoc(yamlText: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(yamlText.trim().length === 0 ? EMPTY_TEMPLATE : yamlText);
  if (doc.errors.length > 0) {
    throw new UsersAdminError(`users.yaml parse error: ${doc.errors[0]!.message}`);
  }
  return doc;
}

function usersSeq(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  let seq = doc.get('users');
  if (!seq) {
    doc.set('users', new YAMLSeq());
    seq = doc.get('users');
  }
  if (!(seq instanceof YAMLSeq)) {
    throw new UsersAdminError('users key is not a list');
  }
  return seq;
}

function findUserIndex(seq: YAMLSeq, handle: string): number {
  return seq.items.findIndex(
    (item) =>
      typeof (item as { get?: (k: string) => unknown }).get === 'function' &&
      (item as { get: (k: string) => unknown }).get('handle') === handle,
  );
}

/** Validate by round-trip: the mutated document must load cleanly. */
function serializeValidated(doc: ReturnType<typeof parseDocument>): string {
  const out = doc.toString();
  parseUsersConfig(out); // throws UsersConfigError on any invariant break
  return out;
}

export function addUser(yamlText: string, user: NewUserInput): string {
  const doc = loadDoc(yamlText);
  const seq = usersSeq(doc);
  if (findUserIndex(seq, user.handle) !== -1) {
    throw new UsersAdminError(`user '${user.handle}' already exists`);
  }
  const entry: Record<string, unknown> = {
    handle: user.handle,
    name: user.name,
    email_to: user.emailTo,
    vault_remote: user.vaultRemote,
    onboarded: user.onboarded,
    interests: user.interests,
  };
  if (user.vaultBranch) entry.vault_branch = user.vaultBranch;
  if (user.threshold !== undefined) entry.threshold = user.threshold;
  seq.add(doc.createNode(entry));
  return serializeValidated(doc);
}

export function setUserEnabled(yamlText: string, handle: string, enabled: boolean): string {
  const doc = loadDoc(yamlText);
  const seq = usersSeq(doc);
  const idx = findUserIndex(seq, handle);
  if (idx === -1) throw new UsersAdminError(`no user with handle '${handle}'`);
  const item = seq.items[idx] as { set: (k: string, v: unknown) => void };
  item.set('enabled', enabled);
  return serializeValidated(doc);
}

export function removeUser(yamlText: string, handle: string): string {
  const doc = loadDoc(yamlText);
  const seq = usersSeq(doc);
  const idx = findUserIndex(seq, handle);
  if (idx === -1) throw new UsersAdminError(`no user with handle '${handle}'`);
  seq.items.splice(idx, 1);
  return serializeValidated(doc);
}

// ---------------------------------------------------------------------------
// requeue command — argument parsing + dry-run report formatting.
// ---------------------------------------------------------------------------

export interface RequeueRequest {
  handle: string;
  status: 'failed' | 'skipped';
  /** SQL LIKE pattern for status_reason; null = all reasons. */
  likeReason: string | null;
  /** false = dry-run (default): report only, no writes. */
  execute: boolean;
}

/**
 * Parse `requeue --user <handle> --status failed|skipped [--like <pattern>]
 * [--execute]`. A --like value without SQL wildcards is treated as a
 * substring (wrapped in %...%); a value containing % is passed through as a
 * raw LIKE pattern. Throws UsersAdminError on any invalid input so the CLI
 * fails loudly instead of silently requeueing the wrong cohort.
 */
export function parseRequeueArgs(argv: string[]): RequeueRequest {
  let handle: string | null = null;
  let status: string | null = null;
  let like: string | null = null;
  let execute = false;

  const takeValue = (argv: string[], i: number, flag: string): [string, number] => {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    if (eq !== -1) return [arg.slice(eq + 1), i];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new UsersAdminError(`--${flag} requires a value`);
    }
    return [next, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg.startsWith('--') ? arg.slice(2).split('=')[0]! : null;
    switch (flag) {
      case 'user':
        [handle, i] = takeValue(argv, i, 'user');
        break;
      case 'status':
        [status, i] = takeValue(argv, i, 'status');
        break;
      case 'like':
        [like, i] = takeValue(argv, i, 'like');
        break;
      case 'execute':
        execute = true;
        break;
      default:
        throw new UsersAdminError(`unknown requeue argument '${arg}'`);
    }
  }

  if (!handle) throw new UsersAdminError('--user is required');
  if (status !== 'failed' && status !== 'skipped') {
    throw new UsersAdminError(`--status must be 'failed' or 'skipped'`);
  }
  const likeReason = like === null ? null : like.includes('%') ? like : `%${like}%`;
  return { handle, status, likeReason, execute };
}

/** Dry-run report lines: right-aligned count + (possibly truncated) reason. */
export function formatReasonHistogram(
  entries: Array<{ reason: string | null; count: number }>,
): string[] {
  return entries.map((e) => {
    const reason = e.reason === null ? '(no reason recorded)' : e.reason;
    const shown = reason.length > 100 ? `${reason.slice(0, 97)}...` : reason;
    return `${String(e.count).padStart(6)}  ${shown}`;
  });
}

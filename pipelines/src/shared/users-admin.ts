/**
 * users.yaml mutations for the admin CLI.
 *
 * Pure text → text transforms over the YAML document (via the yaml
 * package's Document API, which preserves comments and key order), each
 * validated by round-tripping the result through parseUsersConfig before
 * returning — a transform that would produce an unloadable config throws
 * instead of writing.
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

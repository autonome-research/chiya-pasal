/**
 * Tiny runtime validation helpers for structured LLM JSON outputs.
 *
 * This is intentionally lightweight: enough to avoid trusting parsed JSON just
 * because TypeScript has a generic parameter, without pulling in a schema lib.
 */

import { parseJSON } from 'thread-phase';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export type Validator<T> = (value: unknown) => ValidationResult<T>;

export function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function invalid<T = never>(reason: string): ValidationResult<T> {
  return { ok: false, reason };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown, max: number = Infinity): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function parseAndValidateJson<T>(
  text: string,
  validate: Validator<T>,
): ValidationResult<T> {
  let parseFailed = false;
  const parsed = parseJSON<unknown>(text, null, () => {
    parseFailed = true;
  });
  if (parseFailed) return invalid('parse-failed');
  return validate(parsed);
}

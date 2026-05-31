import {
  invalid,
  isRecord,
  parseAndValidateJson,
  valid,
  type Validator,
} from '../../shared/llm-schema.js';
import type { SurfacedPage } from './types.js';

export interface SurfacedPagesPayload {
  surfacedPages: SurfacedPage[];
}

export function surfacedPagesValidator(maxPages: number): Validator<SurfacedPagesPayload> {
  return (value) => {
    if (!isRecord(value)) return invalid('parse-failed');
    if (!Array.isArray(value.surfacedPages)) return invalid('parse-failed');
    const cleaned: SurfacedPage[] = [];
    for (const p of value.surfacedPages) {
      if (!isRecord(p)) continue;
      if (typeof p.path !== 'string' || typeof p.excerpt !== 'string' || typeof p.relevanceNote !== 'string') continue;
      cleaned.push({ path: p.path, excerpt: p.excerpt.slice(0, 400), relevanceNote: p.relevanceNote });
      if (cleaned.length >= maxPages) break;
    }
    return valid({ surfacedPages: cleaned });
  };
}

export function parseSurfacedPagesJson(text: string, maxPages: number): ReturnType<Validator<SurfacedPagesPayload>> {
  const parsed = parseAndValidateJson(text, surfacedPagesValidator(maxPages));
  if (!parsed.ok && parsed.reason === 'parse-failed') return parsed;
  if (!parsed.ok) return invalid('parse-failed');
  return parsed;
}

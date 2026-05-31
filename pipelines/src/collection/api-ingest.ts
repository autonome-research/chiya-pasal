#!/usr/bin/env tsx
/**
 * TypeScript replacement for matcha/scripts/api_ingest.py.
 *
 * Emits the same files consumed by matcha/scripts/filter_matcha.py:
 *   - matcha/scripts/api-articles.jsonl
 *   - matcha/scripts/api-digest.md
 */

import { promises as fs } from 'fs';
import { resolve } from 'path';

import { SourceRegistry } from './registry.js';
import { normalizeCandidate, type ArticleCandidate } from './source-adapter.js';
import { renderDigest, renderJsonl } from './render.js';
import { resolveMatchaDir, resolveMatchaScriptsDir } from './paths.js';
import { arxivSource } from './sources/arxiv.js';
import { openAlexSource } from './sources/openalex.js';
import { crossrefSource } from './sources/crossref.js';
import { semanticScholarSource } from './sources/semantic-scholar.js';
import {
  doajSource,
  europePmcSource,
  inspireHepSource,
  ncbiSource,
  osfSource,
  zenodoSource,
} from './sources/legacy-academic.js';

interface QuerySpec {
  query: string;
  field: string;
  sources: string[];
}

const matchaDir = resolveMatchaDir(import.meta.url);
const scriptsDir = resolveMatchaScriptsDir(import.meta.url);
const maxResults = Number(process.env.API_MAX_RESULTS ?? '6');

const QUERIES: QuerySpec[] = [
  { query: 'large language models transformer reinforcement learning', field: 'AI/ML', sources: ['semantic-scholar', 'openalex', 'arxiv', 'crossref', 'ncbi'] },
  { query: 'synthetic biology drug discovery biotech AI', field: 'Biotech', sources: ['europe-pmc', 'openalex', 'ncbi'] },
  { query: 'quantum computing quantum information physics', field: 'Physics', sources: ['inspire-hep', 'arxiv', 'openalex'] },
  { query: 'semiconductor chip EUV lithography nanotech', field: 'Semiconductor', sources: ['crossref', 'openalex'] },
  { query: 'climate energy storage battery renewable', field: 'Energy/Climate', sources: ['zenodo', 'openalex'] },
  { query: 'deep learning computer vision AI architecture', field: 'AI/ML', sources: ['semantic-scholar', 'arxiv', 'crossref', 'osf'] },
  { query: 'cybersecurity cryptography threat intelligence', field: 'Cybersecurity', sources: ['semantic-scholar', 'inspire-hep', 'arxiv', 'crossref'] },
  { query: 'robotics autonomous systems reinforcement', field: 'Robotics', sources: ['arxiv', 'openalex', 'osf'] },
  { query: 'space technology aerospace satellite', field: 'Space/Aerospace', sources: ['arxiv', 'zenodo', 'openalex'] },
  { query: 'nuclear fusion energy technology', field: 'Nuclear/Fusion', sources: ['inspire-hep', 'openalex'] },
  { query: 'materials science MOF nanomaterial', field: 'Materials Science', sources: ['zenodo', 'crossref', 'openalex'] },
  { query: 'open access AI research reproducibility datasets', field: 'Open Access', sources: ['doaj'] },
];

const REGISTERED_SOURCES = [
  arxivSource,
  openAlexSource,
  crossrefSource,
  semanticScholarSource,
  zenodoSource,
  doajSource,
  europePmcSource,
  inspireHepSource,
  ncbiSource,
  osfSource,
];

async function main(): Promise<void> {
  const interests = await loadInterests(resolve(matchaDir, 'interests.yaml'));
  const registry = REGISTERED_SOURCES.reduce(
    (r, source) => r.register(source),
    new SourceRegistry(),
  );

  const candidates: ArticleCandidate[] = [];
  const reports = [];

  for (const spec of QUERIES) {
    for (const source of spec.sources) {
      const adapter = registry.get(source);
      if (!adapter) continue;
      try {
        const query = source === 'arxiv' ? queryToArxiv(spec.query) : spec.query;
        const result = await adapter.fetch({ query, maxResults, field: spec.field }, { now: new Date(), interests });
        candidates.push(...result.candidates);
        reports.push(result.report);
      } catch (err) {
        reports.push({ source, fetched: 0, emitted: 0, dropped: 0, warnings: [err instanceof Error ? err.message : String(err)] });
      }
    }
  }

  const unique = dedupeCandidates(candidates).slice(0, Number(process.env.API_TOTAL_MAX ?? '500'));
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(resolve(scriptsDir, 'api-articles.jsonl'), renderJsonl(unique), 'utf8');
  await fs.writeFile(resolve(scriptsDir, 'api-digest.md'), renderDigest(unique, reports), 'utf8');
  console.log(`[api-ingest-ts] emitted ${unique.length} candidates from ${reports.length} source runs`);
}

function dedupeCandidates(candidates: ArticleCandidate[]): ArticleCandidate[] {
  const seen = new Set<string>();
  const out: ArticleCandidate[] = [];
  for (const c of candidates.map(normalizeCandidate)) {
    const key = (c.doi ? `doi:${c.doi}` : c.arxivId ? `arxiv:${c.arxivId}` : `url:${normalizeUrl(c.url)}`).toLowerCase();
    const titleKey = `title:${c.title.toLowerCase().replace(/\s+/g, ' ')}`;
    if (seen.has(key) || seen.has(titleKey)) continue;
    seen.add(key);
    seen.add(titleKey);
    out.push(c);
  }
  return out;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function queryToArxiv(query: string): string {
  const terms = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
  return terms.map((t) => `all:${t}`).join(' AND ');
}

async function loadInterests(path: string): Promise<Record<string, string[]>> {
  try {
    const text = await fs.readFile(path, 'utf8');
    const out: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of text.split('\n')) {
      const group = /^\s{2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (group) {
        current = group[1]!;
        out[current] = [];
        continue;
      }
      const item = /^\s{4}-\s+"?(.+?)"?\s*$/.exec(line);
      if (item && current) out[current]!.push(item[1]!);
    }
    return out;
  } catch {
    return {};
  }
}

main().catch((err) => {
  console.error('[api-ingest-ts] fatal:', err);
  process.exit(1);
});

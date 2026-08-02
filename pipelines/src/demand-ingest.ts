#!/usr/bin/env tsx
/**
 * Demand-driven citation ingestion (tier 3) — the vault's "surface the most
 * important historical research" engine.
 *
 * The librarian records every reference a source page cites that the library
 * does NOT have into the shared `citation_demand` ledger. When the same
 * missing paper is cited by K different in-library articles, the vault has
 * effectively voted for it: it is a foundational work the collection layer
 * (which only ever sees new publications) will never surface on its own.
 *
 * This job is deliberately NOT a thread-phase pipeline. It has no vault
 * access, no git, no LLM, no per-user state, and exactly one artifact:
 *
 *   ledger → unsatisfied high-demand refs → arXiv/Crossref metadata
 *          → ONE <date>-demand-articles.md written into the shared inbox
 *
 * From there the normal shared pipeline owns everything (absorb dedups by
 * stable id, enrich fetches full text, the quality gate can still reject it,
 * routing distributes it). That is why the job defaults to executing rather
 * than dry-running: its only side effect is additive, and the canonical URLs
 * it emits map to the same stable ids collection would produce, so a paper
 * that arrives twice is absorbed once.
 *
 * Usage:
 *   tsx src/demand-ingest.ts [--min-citers=3] [--limit=25] [--user=<handle>] [--dry-run]
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { loadSharedEnv } from './shared/env.js';
import {
  SharedArticleStore,
  type UnsatisfiedDemand,
} from './shared/shared-article-store.js';
import {
  demandRefStableId,
  resolveDemandRefs,
  type DemandRef,
  type DemandResolution,
  type RefMetadata,
} from './shared/demand-resolver.js';

export interface DemandIngestOptions {
  /** Distinct in-library citers a ref needs before it is worth fetching. */
  minCiters: number;
  /** Hard cap on articles emitted per run. */
  limit: number;
  dryRun: boolean;
  /** Restrict the ledger to one user's demand (default: all users). */
  userHandle?: string;
}

export const DEFAULT_OPTIONS: DemandIngestOptions = {
  minCiters: 3,
  limit: 25,
  dryRun: false,
};

export interface DemandIngestSummary {
  eligible: number;
  satisfiedSkipped: number;
  unmapped: number;
  /** Refs that passed the filters and were handed to the resolver. */
  considered: number;
  resolved: number;
  emitted: number;
  failed: number;
  /** Short 'kind:id — reason' strings, for the run log. */
  failures: string[];
  outPath: string | null;
  dryRun: boolean;
  /** Ref ids in emit order (most-demanded first). */
  order: string[];
}

/** Metadata resolution, injected so tests never touch the network. */
export type DemandRefResolver = (refs: DemandRef[]) => Promise<DemandResolution>;

export function parseArgs(argv = process.argv.slice(2)): DemandIngestOptions {
  const opts: DemandIngestOptions = { ...DEFAULT_OPTIONS };
  for (const arg of argv) {
    let m: RegExpExecArray | null;
    if ((m = /^--min-citers=(\d+)$/.exec(arg))) {
      opts.minCiters = Math.max(1, Number(m[1]));
    } else if ((m = /^--limit=(\d+)$/.exec(arg))) {
      opts.limit = Number(m[1]);
    } else if ((m = /^--user=(.+)$/.exec(arg))) {
      opts.userHandle = m[1];
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else {
      throw new Error(`unknown demand-ingest argument: ${arg}`);
    }
  }
  return opts;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function demandFileName(now: Date): string {
  // Must end in `-articles.md`: that glob is what scanSharedInbox picks up.
  return `${ymd(now)}-demand-articles.md`;
}

/**
 * Titles may not contain `]` and URLs may not contain `)` — the matcha
 * article line is parsed by a single regex with those delimiters. Titles are
 * repaired (brackets are cosmetic); a URL that can't be rendered is dropped
 * by the caller, since a mangled URL means a wrong stable id.
 */
function safeTitle(title: string): string {
  return title.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim();
}

function renderableUrl(url: string): boolean {
  return url.length > 0 && !/[()\s]/.test(url);
}

export interface DemandEmission {
  metadata: RefMetadata;
  demandCount: number;
}

/**
 * Render the shared-inbox file. The format is exactly what `parseArticles`
 * reads — `#### <Field>` headings plus `- [Title](url) *(source)* — snippet`
 * — so the emitted file is indistinguishable from a matcha collection file
 * to everything downstream. The `<!-- -->` lines carry the demand evidence
 * for a human reading the archive; the parser ignores them.
 */
export function renderDemandArticles(items: readonly DemandEmission[], now: Date): string {
  const lines: string[] = [
    '---',
    `date: ${ymd(now)}`,
    'generator: demand-ingest',
    'kind: demand',
    '---',
    '',
    `# Raw Articles — ${ymd(now)}`,
    '',
    '> Highly-cited references missing from the library, surfaced from the citation demand ledger.',
    '',
    '---',
    `### Collected at ${now.toISOString().slice(11, 16)}`,
    `### ${items.length} new articles`,
    '',
    '#### Demand',
  ];
  for (const item of items) {
    lines.push(
      `<!-- ${item.metadata.refKind}:${item.metadata.refId} citers=${item.demandCount} via=${item.metadata.metadataSource} -->`,
    );
    const snippet = item.metadata.abstract ? ` — ${item.metadata.abstract}` : '';
    lines.push(`- [${safeTitle(item.metadata.title)}](${item.metadata.url}) *(demand)*${snippet}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatDemandSummary(s: DemandIngestSummary): string {
  return (
    `[demand] eligible=${s.eligible} satisfied-skipped=${s.satisfiedSkipped} ` +
    `unmapped=${s.unmapped} considered=${s.considered} resolved=${s.resolved} ` +
    `emitted=${s.emitted} failed=${s.failed}${s.dryRun ? ' (dry-run)' : ''}` +
    (s.outPath ? `\n[demand] wrote ${s.outPath}` : '') +
    (s.failures.length > 0 ? `\n[demand] failures: ${s.failures.slice(0, 10).join('; ')}` : '')
  );
}

export interface DemandIngestDeps {
  store: SharedArticleStore;
  inboxDir: string;
  resolve: DemandRefResolver;
  options?: Partial<DemandIngestOptions>;
  now?: Date;
  log?: (line: string) => void;
}

/**
 * One demand-ingest run. Pure enough to test end-to-end: the store is a tmp
 * SQLite file, the resolver is injected, and the only write is the inbox file.
 */
export async function runDemandIngest(deps: DemandIngestDeps): Promise<DemandIngestSummary> {
  const options: DemandIngestOptions = { ...DEFAULT_OPTIONS, ...deps.options };
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((line: string) => console.log(line));

  const report = deps.store.unsatisfiedCitationDemand({
    stableIdFor: demandRefStableId,
    minCiters: options.minCiters,
    limit: options.limit,
    userHandle: options.userHandle,
  });

  const wanted: UnsatisfiedDemand[] = report.rows;
  const base: DemandIngestSummary = {
    eligible: report.eligible,
    satisfiedSkipped: report.satisfied,
    unmapped: report.unmapped,
    considered: wanted.length,
    resolved: 0,
    emitted: 0,
    failed: 0,
    failures: [],
    outPath: null,
    dryRun: options.dryRun,
    order: wanted.map((w) => `${w.refKind}:${w.refId}`),
  };

  if (options.dryRun) {
    for (const w of wanted) {
      log(`[demand] would emit ${w.refKind}:${w.refId} citers=${w.demandCount} → ${w.stableId}`);
    }
    return base;
  }

  if (wanted.length === 0) return base;

  // Resolution preserves input order, so the most-demanded refs stay first.
  const resolution = await deps.resolve(wanted.map((w) => ({ refKind: w.refKind, refId: w.refId })));
  const demandByRef = new Map(wanted.map((w) => [`${w.refKind}:${w.refId}`, w]));

  const failures = resolution.failures.map(
    (f) => `${f.refKind}:${f.refId} — ${f.reason}${f.retryable ? ' (retryable)' : ''}`,
  );

  const emissions: DemandEmission[] = [];
  for (const metadata of resolution.resolved) {
    const demand = demandByRef.get(`${metadata.refKind}:${metadata.refId}`);
    if (!renderableUrl(metadata.url) || safeTitle(metadata.title).length === 0) {
      failures.push(`${metadata.refKind}:${metadata.refId} — unrenderable title/url`);
      continue;
    }
    emissions.push({ metadata, demandCount: demand?.demandCount ?? 0 });
  }

  let outPath: string | null = null;
  if (emissions.length > 0) {
    await mkdir(deps.inboxDir, { recursive: true });
    outPath = join(deps.inboxDir, demandFileName(now));
    await writeFile(outPath, renderDemandArticles(emissions, now), 'utf8');
  }

  return {
    ...base,
    resolved: resolution.resolved.length,
    emitted: emissions.length,
    failed: failures.length,
    failures,
    outPath,
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const env = loadSharedEnv();
  const contactEmail = process.env.CHIYA_CONTACT_EMAIL?.trim() || env.unpaywallEmail;

  console.log(
    `[demand] db=${env.sharedDb} inbox=${env.inboxDir} min-citers=${options.minCiters} ` +
      `limit=${options.limit}${options.userHandle ? ` user=${options.userHandle}` : ''}` +
      `${options.dryRun ? ' dry-run' : ''}` +
      (contactEmail ? '' : '\n[demand] WARN: no contact email — using the anonymous API pools'),
  );

  const store = new SharedArticleStore(env.sharedDb);
  try {
    const summary = await runDemandIngest({
      store,
      inboxDir: env.inboxDir,
      resolve: (refs) => resolveDemandRefs(refs, { contactEmail }),
      options,
    });
    console.log(formatDemandSummary(summary));
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[demand] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

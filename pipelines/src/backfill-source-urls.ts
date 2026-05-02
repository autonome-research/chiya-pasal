/**
 * One-shot backfill of `## Sources` sections on existing wiki pages.
 *
 * Walks `wiki/**\/*.md`. For each page, looks up every 'done' article in
 * ArticleStore whose page_paths includes this page (i.e. articles that
 * actually contributed to it during a librarian run). For citations
 * not yet present in the page, appends them to the page's ## Sources
 * section in the librarian's canonical format:
 *
 *   - [{source} ({collected}): {title}]({url})
 *
 * Idempotent: if the URL is already cited (matched as a substring), it's
 * skipped. Re-running on a fully-backfilled vault is a no-op.
 *
 * Modes:
 *   - default (no flags): dry-run. Prints the diff plan; does not write.
 *   - --apply: writes pages and creates one git commit on the vault.
 *
 * Pages with no contributing articles in ArticleStore are left alone —
 * they came from manual edits, the Hermes era, or other paths the
 * tracker doesn't see. Those are the genuine "no source recorded
 * anywhere" cases that this script can't fix automatically.
 */

import { ArticleStore, type ArticleRow } from './shared/article-store.js';
import { loadChiyaEnv } from './shared/env.js';
import { GitOps } from './tools/git.js';
import { VaultFs } from './tools/vault.js';

interface PlannedAddition {
  pagePath: string;
  newCitations: ArticleRow[];
  /** New total = existing bullet count + newCitations.length. */
  newSourcesCount: number;
  /** Updated full file content, ready to write. */
  updatedText: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatBullet(a: ArticleRow): string {
  const source = a.source ?? 'unknown';
  const date = ymd(a.collectedAt);
  if (a.url) return `- [${source} (${date}): ${a.title}](${a.url})`;
  return `- ${source} (${date}): ${a.title}`;
}

/** Pull every URL out of Markdown link syntax `(http...)` in the page text. */
function extractCitedUrls(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]!);
  return out;
}

/** Count the bullets under the existing `## Sources` heading. 0 if none. */
function countExistingSourceBullets(text: string): number {
  const headerIdx = text.search(/^## Sources\s*$/m);
  if (headerIdx === -1) return 0;
  const after = text.slice(headerIdx);
  // Stop at the next `## ` heading (a sibling section) or end of file.
  const nextHeader = after.slice(11).search(/^## /m);
  const sectionBody = nextHeader === -1 ? after : after.slice(0, nextHeader + 11);
  const bulletMatches = sectionBody.match(/^-\s/gm);
  return bulletMatches?.length ?? 0;
}

/**
 * Append `bullets` to the page's `## Sources` section. If no such section
 * exists, create one at the very end of the file. Also bumps the YAML
 * frontmatter `sources:` field to reflect the new total.
 */
function appendSources(
  original: string,
  bullets: string[],
  newSourcesCount: number,
): string {
  const block = bullets.join('\n');
  let withSources: string;

  const headerMatch = original.match(/^## Sources\s*$/m);
  if (!headerMatch) {
    // Create a fresh section at end-of-file.
    const trimmed = original.replace(/\s+$/, '');
    withSources = `${trimmed}\n\n## Sources\n\n${block}\n`;
  } else {
    // Insert after the last existing line of the existing Sources section.
    const headerIdx = original.indexOf(headerMatch[0]);
    const after = original.slice(headerIdx);
    // Find the next sibling `## ` heading (NOT the Sources header itself).
    const nextHeaderRel = after.slice(headerMatch[0].length).search(/^## /m);
    const sectionEnd =
      nextHeaderRel === -1
        ? original.length
        : headerIdx + headerMatch[0].length + nextHeaderRel;

    const before = original.slice(0, sectionEnd).replace(/\s+$/, '');
    const tail = original.slice(sectionEnd);
    withSources = `${before}\n${block}\n${tail.startsWith('\n') ? tail : '\n' + tail}`;
  }

  // Bump frontmatter `sources:` count if present.
  return withSources.replace(/^sources:\s+\d+/m, `sources: ${newSourcesCount}`);
}

function plan(text: string, articles: ArticleRow[], pagePath: string): PlannedAddition | null {
  const citedUrls = extractCitedUrls(text);
  const newOnes = articles.filter((a) => a.url && !citedUrls.has(a.url));
  if (newOnes.length === 0) return null;

  const existing = countExistingSourceBullets(text);
  const newTotal = existing + newOnes.length;
  const bullets = newOnes.map(formatBullet);
  const updatedText = appendSources(text, bullets, newTotal);

  return {
    pagePath,
    newCitations: newOnes,
    newSourcesCount: newTotal,
    updatedText,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const env = loadChiyaEnv();
  const dbPath = process.env.THREAD_PHASE_DB ?? `${env.vaultDir}/.chiya-pipelines.db`;
  const vault = new VaultFs(env.vaultDir);
  const store = new ArticleStore(dbPath);

  console.log(
    `[backfill] vault=${env.vaultDir} db=${dbPath} mode=${apply ? 'APPLY' : 'dry-run'}`,
  );

  const allPages = await vault.list('wiki/**/*.md');
  const pages = allPages.filter((p) => !p.includes('/archive/'));

  let pagesWithMatches = 0;
  let pagesPlanned = 0;
  let citationsPlanned = 0;
  const plans: PlannedAddition[] = [];

  for (const pagePath of pages) {
    const articles = store.findByPagePath(pagePath);
    if (articles.length === 0) continue;
    pagesWithMatches++;

    const text = await vault.read(pagePath);
    const p = plan(text, articles, pagePath);
    if (!p) continue;

    plans.push(p);
    pagesPlanned++;
    citationsPlanned += p.newCitations.length;
    console.log(
      `[backfill] ${pagePath}: +${p.newCitations.length} citation(s) (sources: → ${p.newSourcesCount})`,
    );
  }

  console.log(
    `[backfill] pages with ArticleStore matches: ${pagesWithMatches}; pages needing citation: ${pagesPlanned}; total new citations: ${citationsPlanned}`,
  );
  console.log(
    `[backfill] pages with no ArticleStore match (left alone): ${pages.length - pagesWithMatches}`,
  );

  if (!apply) {
    console.log('[backfill] dry run — no files written. Re-run with --apply to commit.');
    store.close();
    return;
  }

  if (plans.length === 0) {
    console.log('[backfill] nothing to write.');
    store.close();
    return;
  }

  for (const p of plans) {
    await vault.write(p.pagePath, p.updatedText);
  }

  const git = new GitOps({
    vaultDir: env.vaultDir,
    remote: env.vaultRemote,
    branch: env.vaultBranch,
  });
  const message = `backfill: source URLs into ${pagesPlanned} pages (${citationsPlanned} citations)`;
  const result = await git.commit(message, ['wiki/']);
  if (result.committed) {
    console.log(`[backfill] committed ${result.sha?.slice(0, 7)} — ${message}`);
  } else {
    console.log('[backfill] git: no changes to commit (?)');
  }

  store.close();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});

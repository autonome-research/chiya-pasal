/**
 * Parser for the legacy queue-file format produced by split_queue.py.
 *
 * Each file is one article with YAML frontmatter:
 *
 *   ---
 *   title: <title>
 *   source: <source>
 *   url: <url or empty>
 *   date:
 *   batch: <field>
 *   ---
 *
 *   # <title>
 *
 *   **Source:** [<source>](<url>)
 *
 *   — <snippet first ~100 chars>   (optional)
 *
 *   ---
 *   *Collected: <field>*
 *
 * The `date` field in observed samples is empty; we fall back to file mtime.
 */

import type { Stats } from 'fs';

export interface QueueFileArticle {
  title: string;
  url: string | null;
  source: string | null;
  field: string | null;
  snippet: string | null;
}

const KV_RE = /^([a-z_]+):\s*(.*)$/i;
const SNIPPET_RE = /^—\s*(.+?)\s*$/m;

/**
 * The actual on-disk format from split_queue.py is "loose" YAML — no opening
 * `---` line. Frontmatter runs from line 1 until the first `---` separator,
 * then the body follows.
 *
 * We accept both forms (with or without leading `---`) for safety against
 * historical drift.
 */
export function parseQueueFile(text: string): QueueFileArticle | null {
  const lines = text.split('\n');
  let i = 0;
  // Skip leading `---` if present.
  if (lines[i] === '---') i++;

  const fields: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      i++; // skip the separator
      break;
    }
    const m = KV_RE.exec(line.trim());
    if (m) fields[m[1]!.toLowerCase()] = m[2]!.trim();
    else if (line.trim() !== '') {
      // non-KV line in frontmatter region → not a queue file
      return null;
    }
  }

  const title = fields.title;
  if (!title) return null;

  const body = lines.slice(i).join('\n');
  const snippetMatch = SNIPPET_RE.exec(body);
  const snippet = snippetMatch ? snippetMatch[1]!.trim() : null;

  return {
    title,
    url: fields.url ? fields.url : null,
    source: fields.source || null,
    field: fields.batch || null,
    snippet,
  };
}

/** Pick the best timestamp for collected_at from a queue file. */
export function pickCollectedAt(stats: Stats): Date {
  // mtime is when split_queue.py wrote the file. ctime is metadata change.
  // mtime is the right "this article showed up at..." signal.
  return stats.mtime;
}

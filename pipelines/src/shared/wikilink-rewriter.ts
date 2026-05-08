/**
 * Wikilink rewriter.
 *
 * Updates Obsidian-style [[wikilinks]] across markdown content using a
 * path-rename map. Used by the librarian after a path-flattening migration:
 * once files move from `wiki/topics/<field>/foo` to `wiki/topics/foo`, every
 * wikilink that pointed at the old path needs to follow.
 *
 * Pure: no I/O. Returns a new string.
 *
 * Wikilink form recognized:
 *   [[target]]                     bare
 *   [[target|alias]]               with display alias
 *   [[target.md]]                  .md suffix
 *   [[target#fragment]]            heading anchor
 *   [[target#fragment|alias]]      combined
 *
 * Code regions are skipped so that wikilinks inside fenced code blocks or
 * inline `code` spans render literally, matching how Obsidian itself renders
 * them.
 */

export type RenameMap = Map<string, string>;

// Match [[target]] or [[target|alias]]. Target stops at `|` or `]`. Alias
// (group 2) starts with the leading `|` so we can distinguish "no alias"
// (undefined) from "empty alias" (`|`). Targets are non-empty here so we can
// no-op malformed `[[]]` outside the regex.
const WIKILINK_RE = /\[\[([^|\]\n]+)(\|[^\]\n]*)?\]\]/g;

// Rough fenced-code-block opener: ``` or ~~~ (3+ of either) optionally with
// info string. Same character must close. Indentation up to 3 spaces is
// allowed by CommonMark; we accept that too.
const FENCE_RE = /^ {0,3}(```+|~~~+)/;

interface Resolution {
  /** The new target path to substitute, with form already adjusted. */
  newPath: string;
}

/**
 * Try every reasonable form of `path` against the map. We don't know whether
 * the caller's keys carry the `wiki/` prefix or the `.md` suffix, so we try
 * both. When we find a hit, we adapt the new path to match the form-style of
 * the original wikilink so e.g. `[[topics/old]]` -> `[[topics/new]]` rather
 * than gaining a stray `wiki/` prefix.
 */
function resolve(path: string, map: RenameMap): Resolution | null {
  const hadMd = path.endsWith('.md');
  const bare = hadMd ? path.slice(0, -3) : path;
  const hadWiki = bare.startsWith('wiki/');
  const stripped = hadWiki ? bare.slice('wiki/'.length) : bare;
  const prefixed = hadWiki ? bare : `wiki/${bare}`;

  const candidates = [bare, prefixed, stripped];
  for (const key of candidates) {
    const hit = map.get(key);
    if (hit === undefined) continue;

    // Adapt the new path's wiki-prefix presence to match the original. The
    // new key may or may not carry `wiki/` itself; we strip it if present so
    // we can re-apply uniformly based on the original wikilink's form.
    const newBare = hit.startsWith('wiki/') ? hit.slice('wiki/'.length) : hit;
    let out = hadWiki ? `wiki/${newBare}` : newBare;
    if (hadMd) out = `${out}.md`;
    return { newPath: out };
  }
  return null;
}

/**
 * Process a single line, rewriting wikilinks while skipping inline-code spans.
 * We walk the line, splitting it into alternating code / non-code segments
 * based on backtick runs. CommonMark inline code uses matched runs of N
 * backticks; we follow that rule loosely (find a run, then the next equal-
 * length run closes it). Anything in between is left untouched.
 */
function rewriteLine(line: string, map: RenameMap): string {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      // Measure run length.
      let j = i;
      while (j < line.length && line[j] === '`') j++;
      const runLen = j - i;
      // Find a closing run of the same length.
      let k = j;
      let closed = -1;
      while (k < line.length) {
        if (line[k] === '`') {
          let m = k;
          while (m < line.length && line[m] === '`') m++;
          if (m - k === runLen) {
            closed = m;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (closed === -1) {
        // Unclosed backtick run: emit literally and continue scanning past it.
        out.push(line.slice(i, j));
        i = j;
      } else {
        // Emit the entire code span verbatim.
        out.push(line.slice(i, closed));
        i = closed;
      }
      continue;
    }
    // Non-code chunk: scan forward to the next backtick (or end) and rewrite
    // wikilinks within it.
    let next = i;
    while (next < line.length && line[next] !== '`') next++;
    out.push(rewriteSegment(line.slice(i, next), map));
    i = next;
  }
  return out.join('');
}

function rewriteSegment(segment: string, map: RenameMap): string {
  return segment.replace(WIKILINK_RE, (full, rawTarget: string, alias: string | undefined, offset: number) => {
    // Escaped opener: `\[[...]]` should render literally. The regex matches
    // `[[`, so check the char before the match start.
    if (offset > 0 && segment[offset - 1] === '\\') {
      return full;
    }
    const target = rawTarget.trim();
    if (!target) return full; // [[ ]] / malformed
    if (target.startsWith('#')) return full; // same-page anchor

    // Split off the fragment, keep it for verbatim re-attachment.
    const hashIdx = target.indexOf('#');
    const path = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? '' : target.slice(hashIdx);
    if (!path) return full;

    const resolved = resolve(path, map);
    if (!resolved) return full;

    return `[[${resolved.newPath}${fragment}${alias ?? ''}]]`;
  });
}

export function rewriteWikilinks(text: string, map: RenameMap): string {
  if (!text || map.size === 0) return text;

  const lines = text.split('\n');
  let inFence = false;
  let fenceMarker = '';
  const out: string[] = [];

  for (const line of lines) {
    if (inFence) {
      out.push(line);
      // Closing fence: same marker char, length >= opener (CommonMark allows
      // longer closing). We accept any line that begins (with up to 3 spaces)
      // with a run of fenceMarker chars at least as long as the opener.
      const closer = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1]![0] === fenceMarker[0] && closer[1]!.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    const opener = line.match(FENCE_RE);
    if (opener) {
      out.push(line);
      inFence = true;
      fenceMarker = opener[1]!;
      continue;
    }
    out.push(rewriteLine(line, map));
  }

  return out.join('\n');
}

/**
 * Collect every wikilink target found in `text`, normalized to a bare path
 * (no `.md`, no `#fragment`, no `|alias`). Skips code regions just like the
 * rewriter so callers see the same set of links the rewriter would consider.
 */
export function listWikilinkTargets(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;

  const lines = text.split('\n');
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    if (inFence) {
      const closer = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1]![0] === fenceMarker[0] && closer[1]!.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    const opener = line.match(FENCE_RE);
    if (opener) {
      inFence = true;
      fenceMarker = opener[1]!;
      continue;
    }
    collectFromLine(line, out);
  }

  return out;
}

function collectFromLine(line: string, out: Set<string>): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      let j = i;
      while (j < line.length && line[j] === '`') j++;
      const runLen = j - i;
      let k = j;
      let closed = -1;
      while (k < line.length) {
        if (line[k] === '`') {
          let m = k;
          while (m < line.length && line[m] === '`') m++;
          if (m - k === runLen) {
            closed = m;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      i = closed === -1 ? j : closed;
      continue;
    }
    let next = i;
    while (next < line.length && line[next] !== '`') next++;
    const segment = line.slice(i, next);
    for (const m of segment.matchAll(WIKILINK_RE)) {
      const offset = m.index ?? 0;
      if (offset > 0 && segment[offset - 1] === '\\') continue;
      const target = m[1]!.trim();
      if (!target || target.startsWith('#')) continue;
      const hashIdx = target.indexOf('#');
      const path = hashIdx === -1 ? target : target.slice(0, hashIdx);
      if (!path) continue;
      const bare = path.endsWith('.md') ? path.slice(0, -3) : path;
      out.add(bare);
    }
    i = next;
  }
}

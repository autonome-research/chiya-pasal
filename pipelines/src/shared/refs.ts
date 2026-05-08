/**
 * Reference extraction for the librarian.
 *
 * Scans arbitrary article text for cited arxiv IDs and DOIs so the librarian
 * can resolve those references against the rest of the corpus and build a
 * citation graph. Pure regex-based; no I/O, no network.
 *
 * Conservative bias: false negatives over false positives. We don't want to
 * pollute the citation graph with bogus edges from phone numbers, dates, or
 * version strings that happen to look like identifiers.
 */

// arxiv known categories. Whitelisting prevents bogus matches like
// `searches/0501001` from looking like an old-style arxiv ID. This list
// covers every top-level / hyphenated category arxiv has used since 1991.
const ARXIV_CATEGORIES = [
  'astro-ph',
  'cond-mat',
  'gr-qc',
  'hep-ex',
  'hep-lat',
  'hep-ph',
  'hep-th',
  'math-ph',
  'nlin',
  'nucl-ex',
  'nucl-th',
  'physics',
  'quant-ph',
  'cs',
  'math',
  'q-bio',
  'q-fin',
  'stat',
  'eess',
  'econ',
];

// Modern arxiv ID: YYMM.NNNNN[v\d+]. YY is 2-digit year (no constraint, since
// arxiv keeps issuing them); MM is 01-12 (the month constraint is what filters
// out things like `1234.5678` from a phone number). NNNNN is 4-5 digits.
//
// Lookbehind blocks word chars, dot, and hyphen — that prevents `2024-05.04`,
// `v0.18.2`, and joined-up tokens from latching on. Lookahead blocks another
// digit so a 6-digit suffix doesn't get truncated to 5; combined with greedy
// `\d{4,5}` and backtracking, this rejects things like `2605.038231` entirely.
// We deliberately do NOT block `.` after the suffix so `2605.03823.pdf` works.
const ARXIV_MODERN_RE =
  /(?<![\w.\-])(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5})(v\d+)?(?!\d)/g;

// Old-style arxiv ID: <category>[.<SUBCLASS>]/NNNNNNN[v\d+]. SUBCLASS is two
// uppercase letters (e.g. `cs.AI`, `math.AG`). We require an exact category
// match against ARXIV_CATEGORIES to avoid matches on arbitrary `word/NNNNNNN`
// tokens. Lookbehind blocks word chars and hyphens; we deliberately do NOT
// block `/` so URLs like `arxiv.org/abs/cs.AI/0501001` still match.
const ARXIV_OLDSTYLE_RE = new RegExp(
  String.raw`(?<![\w\-])((?:${ARXIV_CATEGORIES.join('|')})(?:\.[A-Z]{2})?\/\d{7})(v\d+)?(?!\w)`,
  'g',
);

// DOI: 10.<registrant>/<suffix>. Registrant is 4-9 digits per the DOI
// handbook. Suffix can contain almost anything; we stop at whitespace, common
// closing punctuation, or end of string. The non-greedy `+?` plus the
// lookahead is what makes `(see 10.x/y)` strip the trailing `)` and
// `10.x/y, ...` strip the trailing `,`.
//
// We do NOT treat a bare `.` as a terminator because real DOIs contain dots
// (e.g., `10.5281/zenodo.1234567`, `10.1145/3580305.3599350`). A trailing
// sentence-ending period is stripped only when followed by whitespace or EOS.
const DOI_RE =
  /(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+?)(?=[\s)\]"'<>,]|\.(?:\s|$)|$)/g;

export function extractArxivIds(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  // Run both regexes and merge results in source-position order.
  type Hit = { start: number; id: string };
  const hits: Hit[] = [];

  for (const m of text.matchAll(ARXIV_MODERN_RE)) {
    if (m.index === undefined) continue;
    hits.push({ start: m.index, id: m[1]! });
  }
  for (const m of text.matchAll(ARXIV_OLDSTYLE_RE)) {
    if (m.index === undefined) continue;
    hits.push({ start: m.index, id: m[1]! });
  }

  hits.sort((a, b) => a.start - b.start);

  for (const { id } of hits) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }

  return out;
}

export function extractDois(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of text.matchAll(DOI_RE)) {
    const lower = m[1]!.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }

  return out;
}

// Stub: arxiv has no general references endpoint. Real references would have
// to come from INSPIRE-HEP, Semantic Scholar, or OpenAlex referenced_works.
// We export the signature now so a downstream phase can swap in the real
// implementation without touching the librarian.
export async function fetchArxivStructuredRefs(_arxivId: string): Promise<string[]> {
  return Promise.resolve([]);
}

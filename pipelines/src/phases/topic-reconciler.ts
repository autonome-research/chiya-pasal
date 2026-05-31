/**
 * topic-reconciler — deterministic post-validation for the reviewer's
 * topic-membership output (reviewer.ts).
 *
 * Two invariants the LLM doesn't reliably maintain:
 *
 *   1. New-topic-already-exists (false-new). Folded back: the slug stays
 *      in decisions but is removed from newTopics. Tested with gemma4:26b
 *      which proposed `platform-interoperability` as new while looking at
 *      a topic list of 722 that included it.
 *
 *   2. Hallucinated slug (not in existing, not in newTopics). Dropped from
 *      decisions; if the article ends up with no topics, falls back to
 *      'uncategorized'.
 */

export interface TopicDecision {
  /** Article identifier. */
  i: number;
  topics: string[];
}

export interface TopicProposal {
  slug: string;
  definition: string;
  /** Member identifiers (article indices or ids). Length >= 1. */
  members: number[];
}

export interface TopicOutput {
  decisions: TopicDecision[];
  newTopics: TopicProposal[];
}

export interface ReconcileResult {
  reconciled: TopicOutput;
  foldedSlugs: string[];
  /** New-topic proposals dropped because they duplicate another new proposal in the same output. */
  dedupedNewSlugs: Array<{ slug: string; matched: string }>;
  droppedHallucinations: Array<{ i: number; slug: string }>;
}

export function reconcileTopicOutput(
  output: TopicOutput,
  existingSlugs: ReadonlySet<string>,
): ReconcileResult {
  const foldedSlugs: string[] = [];
  const trulyNew: TopicProposal[] = [];
  const dedupedNewSlugs: Array<{ slug: string; matched: string }> = [];
  const newSlugAliases = new Map<string, string>();
  const acceptedNewSlugs = new Set<string>();

  for (const nt of output.newTopics) {
    if (existingSlugs.has(nt.slug)) {
      foldedSlugs.push(nt.slug);
      continue;
    }

    const nearExisting = isNearDuplicate(nt.slug, acceptedNewSlugs);
    if (nearExisting.duplicate) {
      dedupedNewSlugs.push({ slug: nt.slug, matched: nearExisting.matched });
      newSlugAliases.set(nt.slug, nearExisting.matched);
      continue;
    }

    trulyNew.push(nt);
    acceptedNewSlugs.add(nt.slug);
  }
  const trulyNewSlugs = new Set(trulyNew.map((nt) => nt.slug));

  const droppedHallucinations: Array<{ i: number; slug: string }> = [];
  const decisions: TopicDecision[] = output.decisions.map((d) => {
    const kept: string[] = [];
    for (const originalSlug of d.topics) {
      const slug = newSlugAliases.get(originalSlug) ?? originalSlug;
      if (existingSlugs.has(slug) || trulyNewSlugs.has(slug)) {
        if (!kept.includes(slug)) kept.push(slug);
        continue;
      }
      droppedHallucinations.push({ i: d.i, slug: originalSlug });
    }
    return { i: d.i, topics: kept.length > 0 ? kept : ['uncategorized'] };
  });

  return {
    reconciled: { decisions, newTopics: trulyNew },
    foldedSlugs,
    dedupedNewSlugs,
    droppedHallucinations,
  };
}

// ---------------------------------------------------------------------------
// New-topic gate (v3 only): the librarian only creates a topic page when the
// reviewer's proposal passes both checks below.
// ---------------------------------------------------------------------------

/**
 * Conservative duplicate detector. A proposed slug is a near-duplicate of an
 * existing slug if either:
 *   - lower-cased exact match (the reconciler already handles this; included
 *     for safety in case the gate runs against a different slug set), OR
 *   - normalized match (strip dashes, lowercase, then equal), OR
 *   - one is a strict prefix of the other and the difference is <=3 chars
 *     (e.g. 'llm-evaluation' vs 'llm-evaluations' or 'llm-eval').
 */
export function isNearDuplicate(
  proposedSlug: string,
  existingSlugs: ReadonlySet<string>,
): { duplicate: true; matched: string } | { duplicate: false } {
  const norm = (s: string): string => s.toLowerCase().replace(/-/g, '');
  const contentKey = (s: string): string => s
    .toLowerCase()
    .split('-')
    .filter((part) => part && !['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with'].includes(part))
    .join('');
  const target = norm(proposedSlug);
  const targetContent = contentKey(proposedSlug);
  for (const existing of existingSlugs) {
    if (existing.toLowerCase() === proposedSlug.toLowerCase()) {
      return { duplicate: true, matched: existing };
    }
    const en = norm(existing);
    if (en === target) return { duplicate: true, matched: existing };
    if (contentKey(existing) === targetContent) return { duplicate: true, matched: existing };
    const longer = target.length >= en.length ? target : en;
    const shorter = target.length >= en.length ? en : target;
    if (longer.startsWith(shorter) && longer.length - shorter.length <= 3) {
      return { duplicate: true, matched: existing };
    }
  }
  return { duplicate: false };
}

/**
 * Substantiveness check on a proposed topic's definition. The reviewer can
 * propose a slug + a 1-2 sentence definition; the gate enforces that the
 * definition is at least one full sentence with enough words to be
 * meaningful (not just "AI stuff" or "papers about X").
 */
export function isSubstantiveDefinition(definition: string): boolean {
  const trimmed = definition.trim();
  if (trimmed.length < 30) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 6) return false;
  // Require at least one sentence-ending punctuation mark or a clear clause.
  if (!/[.!?]/.test(trimmed) && wordCount < 10) return false;
  return true;
}

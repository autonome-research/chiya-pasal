import { describe, it, expect } from 'vitest';

import {
  cosine,
  routeArticles,
  routeArticlesDetailed,
  userSimilarity,
  DEFAULT_THRESHOLD,
} from '../src/shared/routing.js';

describe('cosine', () => {
  it('returns 1 for identical non-zero vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0.0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1.0, 6);
  });

  it('returns 0 when either vector is all-zero', () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns 0 when lengths differ', () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosine([], [])).toBe(0);
  });
});

describe('userSimilarity', () => {
  it('takes the max across multiple interest vectors', () => {
    const interests = [
      [1, 0, 0, 0], // interpretability
      [0, 0, 1, 0], // protein design
    ];
    // Article aligned with the SECOND interest should score ~1, not the
    // centroid's ~0.7.
    expect(userSimilarity([0, 0, 1, 0], interests)).toBeCloseTo(1.0, 6);
    expect(userSimilarity([1, 0, 0, 0], interests)).toBeCloseTo(1.0, 6);
    // Orthogonal to both → 0.
    expect(userSimilarity([0, 1, 0, 0], interests)).toBeCloseTo(0.0, 6);
  });

  it('returns 0 for an empty interest list', () => {
    expect(userSimilarity([1, 0], [])).toBe(0);
  });
});

describe('routeArticles', () => {
  // Test users live in mutually orthogonal dimensions so we can control
  // exactly which user a given article vector aligns with.
  const interpUser = { handle: 'alice', interestVectors: [[1, 0, 0, 0]] };
  const proteinUser = { handle: 'bob', interestVectors: [[0, 0, 1, 0]] };
  const physicsUser = { handle: 'carol', interestVectors: [[0, 0, 0, 1]] };

  it('routes an article to every user whose interest is above threshold', () => {
    const articles = [
      { stableId: 'art-1', summaryVector: [0.9, 0.1, 0, 0] },        // alice only
      { stableId: 'art-2', summaryVector: [0, 0.1, 0.9, 0] },        // bob only
      { stableId: 'art-3', summaryVector: [0.6, 0, 0.6, 0.5] },      // all three
    ];
    const matches = routeArticles(articles, [interpUser, proteinUser, physicsUser], {
      threshold: 0.5,
    });

    const byArticle = (id: string): string[] =>
      matches.filter((m) => m.stableId === id).map((m) => m.userHandle);
    expect(byArticle('art-1')).toEqual(['alice']);
    expect(byArticle('art-2')).toEqual(['bob']);
    expect(byArticle('art-3').sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('honors per-user threshold overrides', () => {
    // sim with alice [1,0,0,0] ≈ 0.451; default 0.5 rejects, alice's 0.4 accepts.
    const article = [{ stableId: 'art-1', summaryVector: [0.45, 0.89, 0, 0] }];
    const aliceLoose = { ...interpUser, threshold: 0.4 };
    const matches = routeArticles(article, [aliceLoose, proteinUser], { threshold: 0.5 });
    expect(matches.map((m) => m.userHandle)).toEqual(['alice']);
  });

  it('sorts within an article by similarity descending', () => {
    // alice highest, bob middle, carol low — orthogonal dims mean sims directly track coefficients.
    const article = [{ stableId: 'art-1', summaryVector: [0.9, 0, 0.7, 0.6] }];
    const matches = routeArticles(
      article,
      [interpUser, proteinUser, physicsUser],
      { threshold: 0.4 },
    );
    const sims = matches.map((m) => m.similarity);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
    expect(matches.map((m) => m.userHandle)).toEqual(['alice', 'bob', 'carol']);
  });

  it('caps matches per article when maxUsersPerArticle is set', () => {
    const article = [{ stableId: 'art-1', summaryVector: [0.9, 0, 0.7, 0.6] }];
    const matches = routeArticles(
      article,
      [interpUser, proteinUser, physicsUser],
      { threshold: 0.4, maxUsersPerArticle: 2 },
    );
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.userHandle)).toEqual(['alice', 'bob']);
  });

  it('returns empty when no users meet the threshold', () => {
    // sim with [1,0,0,0] is 0.3 / 1.0 ≈ 0.3 (the off-axis dims dominate the magnitude)
    const article = [{ stableId: 'art-orphan', summaryVector: [0.3, 0.95, 0.05, 0] }];
    const matches = routeArticles(article, [interpUser], { threshold: 0.5 });
    expect(matches).toEqual([]);
  });

  it('uses DEFAULT_THRESHOLD when none is provided', () => {
    // 0.43 — deliberately lenient for vault entry; see routing.ts docstring.
    expect(DEFAULT_THRESHOLD).toBe(0.43);
    // sim with [1,0,0,0] ≈ 0.371 — under the default 0.43
    const article = [{ stableId: 'art-1', summaryVector: [0.37, 0.925, 0, 0] }];
    const matches = routeArticles(article, [interpUser]); // no opts
    expect(matches).toEqual([]);
    // sim ≈ 0.451 — above the default now.
    const near = [{ stableId: 'art-2', summaryVector: [0.45, 0.89, 0, 0] }];
    expect(routeArticles(near, [interpUser])).toHaveLength(1);
  });

  it('handles empty articles or users arrays without throwing', () => {
    expect(routeArticles([], [interpUser])).toEqual([]);
    expect(routeArticles([{ stableId: 'a', summaryVector: [1, 0, 0, 0] }], [])).toEqual([]);
  });

  it('keeps cross-article ordering stable (article input order)', () => {
    const articles = [
      { stableId: 'first', summaryVector: [1, 0, 0, 0] },
      { stableId: 'second', summaryVector: [1, 0, 0, 0] },
    ];
    const matches = routeArticles(articles, [interpUser], { threshold: 0.5 });
    expect(matches.map((m) => m.stableId)).toEqual(['first', 'second']);
  });

  it('caps matches per user with maxPerUser, keeping the highest-similarity ones', () => {
    // Three articles all above alice's threshold with distinct sims.
    const articles = [
      { stableId: 'low', summaryVector: [0.6, 0, 0.8, 0] },   // sim 0.6
      { stableId: 'high', summaryVector: [1, 0, 0, 0] },      // sim 1.0
      { stableId: 'mid', summaryVector: [0.8, 0, 0.6, 0] },   // sim 0.8
    ];
    const matches = routeArticles(articles, [interpUser], {
      threshold: 0.5,
      maxPerUser: 2,
    });
    expect(matches.map((m) => m.stableId).sort()).toEqual(['high', 'mid']);
  });

  it('tops up a starved user to minPerUser with viaFloor-flagged matches', () => {
    // Nothing meets alice's 0.9 threshold, but the floor guarantees 2.
    const articles = [
      { stableId: 'best', summaryVector: [0.8, 0, 0.6, 0] },   // sim 0.8
      { stableId: 'ok', summaryVector: [0.6, 0, 0.8, 0] },     // sim 0.6
      { stableId: 'weak', summaryVector: [0.2, 0, 0.98, 0] },  // sim 0.2
    ];
    const matches = routeArticles(articles, [{ ...interpUser, threshold: 0.9 }], {
      minPerUser: 2,
    });
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.viaFloor === true)).toBe(true);
    expect(matches.map((m) => m.stableId)).toEqual(['best', 'ok']); // highest first
  });

  it('floor only tops up the deficit when some matches already exist', () => {
    const articles = [
      { stableId: 'above', summaryVector: [1, 0, 0, 0] },      // sim 1.0 — real match
      { stableId: 'below', summaryVector: [0.6, 0, 0.8, 0] },  // sim 0.6 — floored
      { stableId: 'worst', summaryVector: [0, 0, 1, 0] },      // sim 0 — not needed
    ];
    const matches = routeArticles(articles, [{ ...interpUser, threshold: 0.9 }], {
      minPerUser: 2,
    });
    expect(matches).toHaveLength(2);
    const real = matches.find((m) => m.stableId === 'above')!;
    const topped = matches.find((m) => m.stableId === 'below')!;
    expect(real.viaFloor).toBeUndefined();
    expect(topped.viaFloor).toBe(true);
  });

  it('throws when minPerUser exceeds maxPerUser', () => {
    expect(() =>
      routeArticles([], [interpUser], { minPerUser: 5, maxPerUser: 2 }),
    ).toThrow(/minPerUser.*must be <= maxPerUser/);
  });

  it('routeArticlesDetailed returns a score row for every (article, user) pair', () => {
    const articles = [
      { stableId: 'a1', summaryVector: [1, 0, 0, 0] },
      { stableId: 'a2', summaryVector: [0, 0, 1, 0] },
    ];
    const { matches, scores } = routeArticlesDetailed(
      articles,
      [interpUser, proteinUser],
      { threshold: 0.5 },
    );
    expect(scores).toHaveLength(4); // 2 articles × 2 users
    expect(matches).toHaveLength(2); // a1→alice, a2→bob

    const a1alice = scores.find((s) => s.stableId === 'a1' && s.userHandle === 'alice')!;
    expect(a1alice.routed).toBe(true);
    expect(a1alice.viaFloor).toBe(false);
    expect(a1alice.similarity).toBeCloseTo(1.0, 6);

    const a1bob = scores.find((s) => s.stableId === 'a1' && s.userHandle === 'bob')!;
    expect(a1bob.routed).toBe(false);
    expect(a1bob.similarity).toBeCloseTo(0.0, 6);
  });

  it('scores mark floored matches with viaFloor and routed both true', () => {
    const articles = [{ stableId: 'a1', summaryVector: [0.6, 0, 0.8, 0] }];
    const { scores } = routeArticlesDetailed(
      articles,
      [{ ...interpUser, threshold: 0.9 }],
      { minPerUser: 1 },
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]!.routed).toBe(true);
    expect(scores[0]!.viaFloor).toBe(true);
  });

  it('routes a multi-interest user on their best-matching interest, not a centroid', () => {
    // dave has two unrelated interests. An article squarely in his second
    // area must route to him even though the centroid of his two vectors
    // would sit at [0.5, 0, 0.5, 0] → cos ≈ 0.707 vs the pure axis ≈ 1.0.
    const dave = {
      handle: 'dave',
      interestVectors: [
        [1, 0, 0, 0],
        [0, 0, 1, 0],
      ],
    };
    const article = [{ stableId: 'protein-art', summaryVector: [0, 0, 1, 0] }];
    const matches = routeArticles(article, [dave], { threshold: 0.9 });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.similarity).toBeCloseTo(1.0, 6);
  });
});

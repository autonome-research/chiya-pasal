import { describe, it, expect } from 'vitest';

import { cosine, routeArticles, DEFAULT_THRESHOLD } from '../src/shared/routing.js';

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

describe('routeArticles', () => {
  // Test users live in mutually orthogonal dimensions so we can control
  // exactly which user a given article vector aligns with.
  const interpUser = { handle: 'alice', interestVector: [1, 0, 0, 0] };
  const proteinUser = { handle: 'bob', interestVector: [0, 0, 1, 0] };
  const physicsUser = { handle: 'carol', interestVector: [0, 0, 0, 1] };

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
    expect(DEFAULT_THRESHOLD).toBe(0.5);
    // sim with [1,0,0,0] ≈ 0.451 — under the default 0.5
    const article = [{ stableId: 'art-1', summaryVector: [0.45, 0.89, 0, 0] }];
    const matches = routeArticles(article, [interpUser]); // no opts
    expect(matches).toEqual([]);
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
});

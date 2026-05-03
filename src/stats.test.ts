import { describe, expect, it } from 'vitest';
import type { PullRequest } from './provider/types.ts';
import { byAuthor, mean, median, percentile, summary, timeToMergeMs } from './stats.ts';
import { DAY_MS } from './time.ts';

const BASE = new Date('2026-04-01T00:00:00Z');

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'A PR',
    author: { login: 'alice', isBot: false },
    createdAt: BASE,
    closedAt: new Date(BASE.getTime() + DAY_MS),
    mergedAt: new Date(BASE.getTime() + DAY_MS),
    url: 'https://github.com/o/r/pull/1',
    ...overrides,
  };
}

function mergedAfter(login: string, days: number): PullRequest {
  const close = new Date(BASE.getTime() + days * DAY_MS);
  return pr({
    author: { login, isBot: false },
    mergedAt: close,
    closedAt: close,
  });
}

function unmerged(login: string): PullRequest {
  return pr({
    author: { login, isBot: false },
    mergedAt: null,
    closedAt: new Date(BASE.getTime() + DAY_MS),
  });
}

describe('timeToMergeMs', () => {
  it('returns the difference between createdAt and mergedAt in ms', () => {
    expect(timeToMergeMs(mergedAfter('alice', 2))).toBe(2 * DAY_MS);
  });

  it('returns null for unmerged PRs', () => {
    expect(timeToMergeMs(unmerged('alice'))).toBeNull();
  });
});

describe('mean', () => {
  it('returns null for empty input', () => {
    expect(mean([])).toBeNull();
  });

  it('returns the value for a single element', () => {
    expect(mean([5])).toBe(5);
  });

  it('returns the arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([10, 20, 30, 40])).toBe(25);
  });
});

describe('median', () => {
  it('returns null for empty input', () => {
    expect(median([])).toBeNull();
  });

  it('returns the value for a single element', () => {
    expect(median([5])).toBe(5);
  });

  it('returns the middle for odd-length input', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });

  it('returns the average of the two middles for even-length input', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('handles unsorted input', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe('percentile (R-7 linear interpolation)', () => {
  it('returns null for empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('returns the value for a single element regardless of p', () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('p50 of [1..10] is 5.5', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBeCloseTo(5.5);
  });

  it('p90 of [1..10] is 9.1', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
  });

  it('p90 of [1, 2, 3] interpolates correctly', () => {
    // h = 2 * 0.9 = 1.8; lo=1, hi=2; sorted[1] + 0.8*(sorted[2]-sorted[1]) = 2.8
    expect(percentile([1, 2, 3], 0.9)).toBeCloseTo(2.8);
  });

  it('handles unsorted input', () => {
    expect(percentile([10, 1, 5], 0.5)).toBe(5);
  });
});

describe('byAuthor', () => {
  it('returns empty array for empty input', () => {
    expect(byAuthor([])).toEqual([]);
  });

  it('groups PRs by author login', () => {
    const result = byAuthor([
      mergedAfter('alice', 1),
      mergedAfter('alice', 2),
      mergedAfter('bob', 3),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.login === 'alice')?.merged).toBe(2);
    expect(result.find((s) => s.login === 'bob')?.merged).toBe(1);
  });

  it('preserves insertion order (sorting policy belongs to the caller)', () => {
    const result = byAuthor([mergedAfter('alice', 1), mergedAfter('bob', 1)]);
    expect(result.map((s) => s.login)).toEqual(['alice', 'bob']);
  });

  it('computes typical/average/tail in ms', () => {
    const result = byAuthor([
      mergedAfter('alice', 1),
      mergedAfter('alice', 2),
      mergedAfter('alice', 5),
    ]);
    const alice = result[0];
    expect(alice?.merged).toBe(3);
    expect(alice?.typical).toBe(2 * DAY_MS);
    expect(alice?.average).toBeCloseTo(((1 + 2 + 5) / 3) * DAY_MS);
    // p90 of [1, 2, 5]: h=1.8, sorted[1]+0.8*(sorted[2]-sorted[1]) = 2 + 2.4 = 4.4
    expect(alice?.tail).toBeCloseTo(4.4 * DAY_MS);
  });

  it('computes acceptance rate', () => {
    const result = byAuthor([
      mergedAfter('alice', 1),
      mergedAfter('alice', 2),
      unmerged('alice'),
      unmerged('alice'),
    ]);
    expect(result[0]?.merged).toBe(2);
    expect(result[0]?.closedUnmerged).toBe(2);
    expect(result[0]?.accept).toBeCloseTo(0.5);
  });

  it('returns null time stats for authors with no merged PRs', () => {
    const result = byAuthor([unmerged('alice'), unmerged('alice')]);
    expect(result[0]?.typical).toBeNull();
    expect(result[0]?.average).toBeNull();
    expect(result[0]?.tail).toBeNull();
    expect(result[0]?.accept).toBe(0); // 0 merged / 2 decided
  });

  it('returns 100% acceptance when an author has only merged PRs', () => {
    const result = byAuthor([mergedAfter('alice', 1), mergedAfter('alice', 2)]);
    expect(result[0]?.accept).toBe(1);
  });
});

describe('summary', () => {
  it('counts total / merged / closed-unmerged / distinct authors', () => {
    const result = summary([
      mergedAfter('alice', 1),
      mergedAfter('bob', 2),
      unmerged('alice'),
      unmerged('carol'),
    ]);
    expect(result).toEqual({
      totalAnalyzed: 4,
      merged: 2,
      closedUnmerged: 2,
      authors: 3,
    });
  });

  it('handles empty input', () => {
    expect(summary([])).toEqual({
      totalAnalyzed: 0,
      merged: 0,
      closedUnmerged: 0,
      authors: 0,
    });
  });
});

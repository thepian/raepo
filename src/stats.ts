import type { PullRequest } from './provider/types.ts';

export type AuthorStats = {
  login: string;
  /** Count of PRs with mergedAt !== null. */
  merged: number;
  /** Count of PRs that were closed without being merged. */
  closedUnmerged: number;
  /** Median time-to-merge in milliseconds; null when the author has no merged PRs. */
  typical: number | null;
  /** Mean time-to-merge in milliseconds; null when the author has no merged PRs. */
  average: number | null;
  /** 90th-percentile time-to-merge in milliseconds; null when the author has no merged PRs. */
  tail: number | null;
  /** merged / (merged + closedUnmerged); null only when both counts are zero. */
  accept: number | null;
};

export type RepoSummary = {
  totalAnalyzed: number;
  merged: number;
  closedUnmerged: number;
  /** Distinct author logins in the input. */
  authors: number;
};

export function timeToMergeMs(pr: PullRequest): number | null {
  if (pr.mergedAt === null) return null;
  return pr.mergedAt.getTime() - pr.createdAt.getTime();
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

/**
 * R-7 linear-interpolation percentile (the default in NumPy/pandas).
 * `p` is in [0, 1].
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0] as number;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo] as number;
  const frac = h - lo;
  return (sorted[lo] as number) + frac * ((sorted[hi] as number) - (sorted[lo] as number));
}

export function byAuthor(prs: PullRequest[]): AuthorStats[] {
  const grouped = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const list = grouped.get(pr.author.login);
    if (list) list.push(pr);
    else grouped.set(pr.author.login, [pr]);
  }

  const out: AuthorStats[] = [];
  for (const [login, group] of grouped) {
    const mergedTimes: number[] = [];
    let closedUnmerged = 0;
    for (const pr of group) {
      const ttm = timeToMergeMs(pr);
      if (ttm !== null) {
        mergedTimes.push(ttm);
      } else if (pr.closedAt !== null) {
        closedUnmerged += 1;
      }
    }
    const merged = mergedTimes.length;
    const decided = merged + closedUnmerged;
    out.push({
      login,
      merged,
      closedUnmerged,
      typical: median(mergedTimes),
      average: mean(mergedTimes),
      tail: percentile(mergedTimes, 0.9),
      accept: decided === 0 ? null : merged / decided,
    });
  }

  return out;
}

export function summary(prs: PullRequest[]): RepoSummary {
  let merged = 0;
  let closedUnmerged = 0;
  const authors = new Set<string>();
  for (const pr of prs) {
    authors.add(pr.author.login);
    if (pr.mergedAt !== null) {
      merged += 1;
    } else if (pr.closedAt !== null) {
      closedUnmerged += 1;
    }
  }
  return {
    totalAnalyzed: prs.length,
    merged,
    closedUnmerged,
    authors: authors.size,
  };
}

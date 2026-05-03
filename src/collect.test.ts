import { describe, expect, it, vi } from 'vitest';
import { collect } from './collect.ts';
import type {
  ListPullsOptions,
  Provider,
  PullAuthor,
  PullRequest,
  Repo,
} from './provider/types.ts';

const REPO: Repo = { org: 'o', name: 'r' };

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'A PR',
    author: { login: 'alice', isBot: false },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    closedAt: new Date('2026-04-02T00:00:00Z'),
    mergedAt: new Date('2026-04-02T00:00:00Z'),
    url: 'https://github.com/o/r/pull/1',
    ...overrides,
  };
}

function botAuthor(login: string): PullAuthor {
  return { login, isBot: true };
}

function fakeProvider(prs: PullRequest[], capture?: (opts: ListPullsOptions) => void): Provider {
  return {
    name: 'github',
    async *listPulls(_repo, opts = {}) {
      capture?.(opts);
      for (const item of prs) yield item;
    },
  };
}

describe('collect — basic', () => {
  it('returns all PRs from the provider when no filters', async () => {
    const result = await collect(fakeProvider([pr({ number: 1 }), pr({ number: 2 })]), REPO);
    expect(result.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(result.fetched).toBe(2);
    expect(result.filtered).toBe(2);
  });

  it('asks the provider for state=closed', async () => {
    let captured: ListPullsOptions | undefined;
    await collect(
      fakeProvider([], (o) => {
        captured = o;
      }),
      REPO,
    );
    expect(captured?.state).toBe('closed');
  });

  it('returns empty result when the provider yields nothing', async () => {
    const result = await collect(fakeProvider([]), REPO);
    expect(result.prs).toEqual([]);
    expect(result.fetched).toBe(0);
    expect(result.filtered).toBe(0);
  });
});

describe('collect — filter pushdown (since / maxAge)', () => {
  it('pushes `since` down to the provider', async () => {
    let captured: ListPullsOptions | undefined;
    const since = new Date('2026-04-01T00:00:00Z');
    await collect(
      fakeProvider([], (o) => {
        captured = o;
      }),
      REPO,
      { since },
    );
    expect(captured?.since).toEqual(since);
  });

  it('translates `maxAge` into an effective `since` using the injected clock', async () => {
    let captured: ListPullsOptions | undefined;
    const now = new Date('2026-05-03T00:00:00Z');
    await collect(
      fakeProvider([], (o) => {
        captured = o;
      }),
      REPO,
      { maxAge: { days: 30 }, now },
    );
    expect(captured?.since).toEqual(new Date('2026-04-03T00:00:00Z'));
  });

  it('uses the later of `since` and the maxAge floor when both are given', async () => {
    let captured: ListPullsOptions | undefined;
    const now = new Date('2026-05-03T00:00:00Z');
    await collect(
      fakeProvider([], (o) => {
        captured = o;
      }),
      REPO,
      {
        since: new Date('2026-01-01T00:00:00Z'),
        maxAge: { days: 30 },
        now,
      },
    );
    expect(captured?.since).toEqual(new Date('2026-04-03T00:00:00Z'));
  });

  it('keeps `since` when it is already later than the maxAge floor', async () => {
    let captured: ListPullsOptions | undefined;
    const now = new Date('2026-05-03T00:00:00Z');
    await collect(
      fakeProvider([], (o) => {
        captured = o;
      }),
      REPO,
      {
        since: new Date('2026-04-25T00:00:00Z'),
        maxAge: { days: 30 },
        now,
      },
    );
    expect(captured?.since).toEqual(new Date('2026-04-25T00:00:00Z'));
  });
});

describe('collect — client-side filters', () => {
  it('excludes bots by default and reports the count', async () => {
    const result = await collect(
      fakeProvider([
        pr({ number: 1, author: { login: 'alice', isBot: false } }),
        pr({ number: 2, author: botAuthor('dependabot[bot]') }),
        pr({ number: 3, author: { login: 'bob', isBot: false } }),
      ]),
      REPO,
    );
    expect(result.prs.map((p) => p.number)).toEqual([1, 3]);
    expect(result.fetched).toBe(3);
    expect(result.filtered).toBe(2);
    expect(result.botsExcluded).toBe(1);
  });

  it('keeps bots when includeBots is true and reports zero excluded', async () => {
    const result = await collect(
      fakeProvider([
        pr({ number: 1, author: { login: 'alice', isBot: false } }),
        pr({ number: 2, author: botAuthor('dependabot[bot]') }),
      ]),
      REPO,
      { includeBots: true },
    );
    expect(result.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(result.botsExcluded).toBe(0);
  });

  it('restricts to the author allowlist when given', async () => {
    const result = await collect(
      fakeProvider([
        pr({ number: 1, author: { login: 'alice', isBot: false } }),
        pr({ number: 2, author: { login: 'bob', isBot: false } }),
        pr({ number: 3, author: { login: 'carol', isBot: false } }),
      ]),
      REPO,
      { authors: ['alice', 'carol'] },
    );
    expect(result.prs.map((p) => p.number)).toEqual([1, 3]);
  });

  it('treats an empty authors array as "no allowlist" (keeps all)', async () => {
    const result = await collect(fakeProvider([pr({ number: 1 }), pr({ number: 2 })]), REPO, {
      authors: [],
    });
    expect(result.prs).toHaveLength(2);
  });

  it('applies bot exclusion and author allowlist together', async () => {
    const result = await collect(
      fakeProvider([
        pr({ number: 1, author: { login: 'alice', isBot: false } }),
        pr({ number: 2, author: botAuthor('alice[bot]') }), // bot named like alice
        pr({ number: 3, author: { login: 'bob', isBot: false } }),
      ]),
      REPO,
      { authors: ['alice'] },
    );
    expect(result.prs.map((p) => p.number)).toEqual([1]);
  });
});

describe('collect — progress callback', () => {
  it('calls onProgress for each PR yielded by the provider', async () => {
    const onProgress = vi.fn();
    await collect(fakeProvider([pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })]), REPO, {
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2);
    expect(onProgress).toHaveBeenNthCalledWith(3, 3);
  });

  it('counts every PR before filtering, not after', async () => {
    const onProgress = vi.fn();
    await collect(
      fakeProvider([
        pr({ number: 1, author: { login: 'alice', isBot: false } }),
        pr({ number: 2, author: botAuthor('renovate[bot]') }),
        pr({ number: 3, author: { login: 'bob', isBot: false } }),
      ]),
      REPO,
      { onProgress },
    );
    expect(onProgress).toHaveBeenCalledTimes(3);
  });
});

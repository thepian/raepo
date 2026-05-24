/**
 * This test is best as an integration test with GitHub
 */

import { describe, expect, it } from 'vitest';
import { createGithubProvider } from '../../../src/provider/github.ts';
import { ProviderHttpError, ProviderRateLimitError } from '../../../src/provider/types.ts';

type GhUser = { login: string; type?: string } | null;
type GhPull = {
  number: number;
  title: string;
  user: GhUser;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  html_url: string;
};

function pull(overrides: Partial<GhPull> = {}): GhPull {
  return {
    number: 1,
    title: 'A PR',
    user: { login: 'alice', type: 'User' },
    created_at: '2026-04-01T10:00:00Z',
    closed_at: '2026-04-02T10:00:00Z',
    merged_at: '2026-04-02T10:00:00Z',
    html_url: 'https://github.com/o/r/pull/1',
    ...overrides,
  };
}

type MockResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function mockFetch(responses: MockResponse[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const r = responses[i++];
    if (!r) throw new Error(`unexpected fetch call to ${url}`);
    return new Response(JSON.stringify(r.body ?? []), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...r.headers },
    });
  }) as typeof fetch;
  return { fn, calls };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('githubProvider — single page', () => {
  it('lists and normalizes PRs from one page', async () => {
    const { fn } = mockFetch([
      {
        body: [
          pull({ number: 1, user: { login: 'alice', type: 'User' } }),
          pull({
            number: 2,
            user: { login: 'bob', type: 'User' },
            merged_at: null,
            closed_at: '2026-04-03T10:00:00Z',
          }),
        ],
      },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    const prs = await collect(provider.listPulls({ org: 'o', name: 'r' }));

    expect(prs).toHaveLength(2);
    expect(prs[0]).toEqual({
      number: 1,
      title: 'A PR',
      author: { login: 'alice', isBot: false },
      createdAt: new Date('2026-04-01T10:00:00Z'),
      closedAt: new Date('2026-04-02T10:00:00Z'),
      mergedAt: new Date('2026-04-02T10:00:00Z'),
      url: 'https://github.com/o/r/pull/1',
    });
    expect(prs[1]?.mergedAt).toBeNull();
    expect(prs[1]?.closedAt).toEqual(new Date('2026-04-03T10:00:00Z'));
  });

  it('sends Authorization header when a token is given', async () => {
    const { fn, calls } = mockFetch([{ body: [] }]);
    const provider = createGithubProvider({ provider: 'github', token: 'ghp_x', fetch: fn });
    await collect(provider.listPulls({ org: 'o', name: 'r' }));
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer ghp_x' });
  });

  it('omits Authorization header when no token', async () => {
    const { fn, calls } = mockFetch([{ body: [] }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await collect(provider.listPulls({ org: 'o', name: 'r' }));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('defaults to state=closed sorted desc by created', async () => {
    const { fn, calls } = mockFetch([{ body: [] }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await collect(provider.listPulls({ org: 'o', name: 'r' }));
    expect(calls[0]?.url).toContain('state=closed');
    expect(calls[0]?.url).toContain('sort=created');
    expect(calls[0]?.url).toContain('direction=desc');
    expect(calls[0]?.url).toContain('per_page=100');
  });

  it('passes through state=all when requested', async () => {
    const { fn, calls } = mockFetch([{ body: [] }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await collect(provider.listPulls({ org: 'o', name: 'r' }, { state: 'all' }));
    expect(calls[0]?.url).toContain('state=all');
  });
});

describe('githubProvider — pagination', () => {
  it('follows Link rel="next" across pages', async () => {
    const next = 'https://api.github.com/repositories/1/pulls?page=2';
    const { fn, calls } = mockFetch([
      {
        body: [pull({ number: 1 })],
        headers: { Link: `<${next}>; rel="next", <...>; rel="last"` },
      },
      { body: [pull({ number: 2 })] }, // no Link → stop
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    const prs = await collect(provider.listPulls({ org: 'o', name: 'r' }));

    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(next);
  });

  it('stops after a single page when no Link header is returned', async () => {
    const { fn, calls } = mockFetch([{ body: [pull()] }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await collect(provider.listPulls({ org: 'o', name: 'r' }));
    expect(calls).toHaveLength(1);
  });
});

describe('githubProvider — --since short-circuit', () => {
  it('stops iterating mid-page when a PR is older than `since`', async () => {
    const { fn, calls } = mockFetch([
      {
        body: [
          pull({ number: 10, created_at: '2026-04-10T00:00:00Z' }),
          pull({ number: 9, created_at: '2026-04-05T00:00:00Z' }),
          pull({ number: 8, created_at: '2026-03-20T00:00:00Z' }), // older than since
          pull({ number: 7, created_at: '2026-03-15T00:00:00Z' }),
        ],
        headers: { Link: '<https://example.test/page2>; rel="next"' },
      },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    const prs = await collect(
      provider.listPulls({ org: 'o', name: 'r' }, { since: new Date('2026-04-01T00:00:00Z') }),
    );

    expect(prs.map((p) => p.number)).toEqual([10, 9]);
    expect(calls).toHaveLength(1);
  });

  it('continues to next page when all PRs on a page are within `since`', async () => {
    const next = 'https://example.test/page2';
    const { fn, calls } = mockFetch([
      {
        body: [pull({ number: 10, created_at: '2026-04-10T00:00:00Z' })],
        headers: { Link: `<${next}>; rel="next"` },
      },
      { body: [pull({ number: 9, created_at: '2026-03-20T00:00:00Z' })] },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    const prs = await collect(
      provider.listPulls({ org: 'o', name: 'r' }, { since: new Date('2026-04-01T00:00:00Z') }),
    );

    expect(prs.map((p) => p.number)).toEqual([10]);
    expect(calls).toHaveLength(2);
  });
});

describe('githubProvider — errors', () => {
  it('throws ProviderHttpError on a non-2xx, non-rate-limit response', async () => {
    const { fn } = mockFetch([{ status: 404, body: { message: 'Not Found' } }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    await expect(collect(provider.listPulls({ org: 'o', name: 'nope' }))).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 404,
    });
  });

  it('throws ProviderRateLimitError on 403 with x-ratelimit-remaining: 0', async () => {
    const resetUnix = Math.floor(Date.parse('2026-05-03T22:00:00Z') / 1000).toString();
    const { fn } = mockFetch([
      {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': resetUnix },
      },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    const promise = collect(provider.listPulls({ org: 'o', name: 'r' }));
    await expect(promise).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(promise).rejects.toMatchObject({
      resetAt: new Date('2026-05-03T22:00:00Z'),
    });
  });

  it('treats other 403s as a generic HTTP error', async () => {
    const { fn } = mockFetch([
      { status: 403, body: { message: 'Forbidden' }, headers: { 'x-ratelimit-remaining': '4999' } },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    await expect(collect(provider.listPulls({ org: 'o', name: 'r' }))).rejects.toBeInstanceOf(
      ProviderHttpError,
    );
  });

  it('mentions the status code in the error message after retries are exhausted', async () => {
    const { fn } = mockFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const sleeps: number[] = [];
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(collect(provider.listPulls({ org: 'o', name: 'r' }))).rejects.toThrow(/500/);
  });

  it('includes a hint about token resolution on 401', async () => {
    const { fn } = mockFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await expect(collect(provider.listPulls({ org: 'o', name: 'r' }))).rejects.toThrow(
      /token|GITHUB_TOKEN|gh auth/i,
    );
  });
});

describe('githubProvider — 5xx retry with exponential backoff', () => {
  it('retries a 5xx response and returns the eventual success', async () => {
    const { fn, calls } = mockFetch([{ status: 503 }, { body: [pull({ number: 1 })] }]);
    const sleeps: number[] = [];
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const prs = await collect(provider.listPulls({ org: 'o', name: 'r' }));
    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('uses exponential backoff between retries (1s, 2s, 4s)', async () => {
    const { fn } = mockFetch([{ status: 502 }, { status: 502 }, { status: 502 }, { body: [] }]);
    const sleeps: number[] = [];
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    await collect(provider.listPulls({ org: 'o', name: 'r' }));
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('gives up after 3 retries (4 total calls) and surfaces the final error', async () => {
    const { fn, calls } = mockFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      sleep: async () => {},
    });
    await expect(collect(provider.listPulls({ org: 'o', name: 'r' }))).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 500,
    });
    expect(calls).toHaveLength(4);
  });

  it('does not retry 4xx responses', async () => {
    const { fn, calls } = mockFetch([{ status: 404, body: { message: 'Not Found' } }]);
    let slept = false;
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      sleep: async () => {
        slept = true;
      },
    });
    await expect(collect(provider.listPulls({ org: 'o', name: 'r' }))).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(1);
    expect(slept).toBe(false);
  });

  it('does not retry rate-limit responses (different signal)', async () => {
    const { fn, calls } = mockFetch([
      {
        status: 403,
        body: { message: 'rate limit' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
      },
    ]);
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      sleep: async () => {},
    });
    await expect(collect(provider.listPulls({ org: 'o', name: 'r' }))).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('githubProvider — onRateLimit callback', () => {
  it('fires once per successful response with parsed headers', async () => {
    const reset1 = Math.floor(Date.parse('2026-05-03T22:00:00Z') / 1000).toString();
    const reset2 = Math.floor(Date.parse('2026-05-03T23:00:00Z') / 1000).toString();
    const next = 'https://api.github.com/repositories/1/pulls?page=2';
    const { fn } = mockFetch([
      {
        body: [pull({ number: 1 })],
        headers: {
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': reset1,
          Link: `<${next}>; rel="next"`,
        },
      },
      {
        body: [pull({ number: 2 })],
        headers: {
          'x-ratelimit-remaining': '4997',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': reset2,
        },
      },
    ]);
    const events: Array<{ remaining: number; limit: number; resetAt: Date }> = [];
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      onRateLimit: (info) => events.push(info),
    });

    await collect(provider.listPulls({ org: 'o', name: 'r' }));

    expect(events).toEqual([
      { remaining: 4998, limit: 5000, resetAt: new Date('2026-05-03T22:00:00Z') },
      { remaining: 4997, limit: 5000, resetAt: new Date('2026-05-03T23:00:00Z') },
    ]);
  });

  it('does not fire when the response lacks rate-limit headers', async () => {
    const { fn } = mockFetch([{ body: [] }]);
    let fired = false;
    const provider = createGithubProvider({
      provider: 'github',
      fetch: fn,
      onRateLimit: () => {
        fired = true;
      },
    });
    await collect(provider.listPulls({ org: 'o', name: 'r' }));
    expect(fired).toBe(false);
  });
});

describe('githubProvider — server-side author filter (search API)', () => {
  it('routes to /search/issues when authors are specified', async () => {
    const { fn, calls } = mockFetch([
      {
        body: {
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              number: 42,
              title: 'A search result',
              user: { login: 'alice', type: 'User' },
              created_at: '2026-04-01T00:00:00Z',
              closed_at: '2026-04-02T00:00:00Z',
              pull_request: { merged_at: '2026-04-02T00:00:00Z' },
              html_url: 'https://github.com/o/r/pull/42',
            },
          ],
        },
      },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });

    const prs = await collect(provider.listPulls({ org: 'o', name: 'r' }, { authors: ['alice'] }));

    expect(calls[0]?.url).toContain('/search/issues');
    expect(calls[0]?.url).toContain('repo%3Ao%2Fr');
    expect(calls[0]?.url).toContain('is%3Apr');
    expect(calls[0]?.url).toContain('is%3Aclosed');
    expect(calls[0]?.url).toContain('author%3Aalice');
    expect(prs).toEqual([
      {
        number: 42,
        title: 'A search result',
        author: { login: 'alice', isBot: false },
        createdAt: new Date('2026-04-01T00:00:00Z'),
        closedAt: new Date('2026-04-02T00:00:00Z'),
        mergedAt: new Date('2026-04-02T00:00:00Z'),
        url: 'https://github.com/o/r/pull/42',
      },
    ]);
  });

  it('builds a query for multiple authors and includes since', async () => {
    const { fn, calls } = mockFetch([
      { body: { total_count: 0, incomplete_results: false, items: [] } },
    ]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await collect(
      provider.listPulls(
        { org: 'o', name: 'r' },
        { authors: ['alice', 'bob'], since: new Date('2026-01-15T00:00:00Z') },
      ),
    );
    const url = calls[0]?.url ?? '';
    expect(url).toContain('author%3Aalice');
    expect(url).toContain('author%3Abob');
    expect(url).toContain('created%3A%3E%3D2026-01-15');
  });

  it('uses /repos/.../pulls when authors is empty (no server-side filter)', async () => {
    const { fn, calls } = mockFetch([{ body: [] }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    await collect(provider.listPulls({ org: 'o', name: 'r' }, { authors: [] }));
    expect(calls[0]?.url).toContain('/repos/o/r/pulls');
    expect(calls[0]?.url).not.toContain('/search/');
  });
});

describe('githubProvider — bot detection', () => {
  async function botFor(user: { login: string; type?: string } | null) {
    const { fn } = mockFetch([{ body: [pull({ user })] }]);
    const provider = createGithubProvider({ provider: 'github', fetch: fn });
    const [pr] = await collect(provider.listPulls({ org: 'o', name: 'r' }));
    return pr?.author;
  }

  it('flags users with type="Bot"', async () => {
    expect(await botFor({ login: 'something', type: 'Bot' })).toEqual({
      login: 'something',
      isBot: true,
    });
  });

  it.each([
    'dependabot',
    'renovate',
    'github-actions',
  ])('flags well-known bot login: %s', async (login) => {
    const author = await botFor({ login, type: 'User' });
    expect(author?.isBot).toBe(true);
  });

  it('flags any login ending in [bot]', async () => {
    const author = await botFor({ login: 'random-app[bot]', type: 'User' });
    expect(author?.isBot).toBe(true);
  });

  it('does not flag regular users', async () => {
    const author = await botFor({ login: 'alice', type: 'User' });
    expect(author?.isBot).toBe(false);
  });

  it('handles a null user (deleted account → "ghost")', async () => {
    const author = await botFor(null);
    expect(author).toEqual({ login: 'ghost', isBot: false });
  });
});

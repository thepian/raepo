import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type ListPullsOptions,
  type Provider,
  type ProviderConfig,
  ProviderHttpError,
  ProviderRateLimitError,
  type PullAuthor,
  type PullRequest,
  type RateLimitInfo,
  type Repo,
} from './types.ts';

const execFileAsync = promisify(execFile);

const API_BASE = 'https://api.github.com';

/** Backoff schedule for 5xx retries. Length defines the max retry count. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Default sleep — used when ProviderConfig.sleep isn't provided. */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type RequestFn = (url: string) => Promise<Response>;

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

type GhSearchPull = {
  number: number;
  title: string;
  user: GhUser;
  created_at: string;
  closed_at: string | null;
  pull_request?: { merged_at: string | null };
  html_url: string;
};

type GhSearchResponse = { items: GhSearchPull[]; total_count: number; incomplete_results: boolean };

export function createGithubProvider(config: ProviderConfig): Provider {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ?? realSleep;
  const request: RequestFn = (url) =>
    requestWithRetry(fetchImpl, url, config.token, sleep, config.onRateLimit);

  return {
    name: 'github',

    listPulls(repo: Repo, options: ListPullsOptions = {}) {
      // Server-side author filter via search API when authors are specified —
      // dramatically reduces data transferred for large repos.
      if (options.authors && options.authors.length > 0) {
        return iterateSearch(request, repo, options);
      }
      return iteratePulls(request, repo, options);
    },
  };
}

async function* iteratePulls(
  request: RequestFn,
  repo: Repo,
  options: ListPullsOptions,
): AsyncGenerator<PullRequest> {
  const state = options.state ?? 'closed';
  const params = new URLSearchParams({
    state,
    sort: 'created',
    direction: 'desc',
    per_page: '100',
  });

  let url: string | null = `${API_BASE}/repos/${repo.org}/${repo.name}/pulls?${params}`;

  // Go through the pages
  while (url !== null) {
    const res = await request(url);
    const items = (await res.json()) as GhPull[];
    for (const item of items) {
      const pr = normalize(item);
      if (options.since && pr.createdAt < options.since) return;
      yield pr;
    }

    url = nextPageUrl(res.headers.get('link'));
  }
}

async function* iterateSearch(
  request: RequestFn,
  repo: Repo,
  options: ListPullsOptions,
): AsyncGenerator<PullRequest> {
  const q = buildSearchQuery(repo, options);
  const params = new URLSearchParams({
    q,
    sort: 'created',
    order: 'desc',
    per_page: '100',
  });

  let url: string | null = `${API_BASE}/search/issues?${params}`;

  while (url !== null) {
    const res = await request(url);
    const data = (await res.json()) as GhSearchResponse;
    for (const item of data.items) {
      const pr = normalizeSearch(item);
      if (options.since && pr.createdAt < options.since) return;
      yield pr;
    }

    url = nextPageUrl(res.headers.get('link'));
  }
}

/**
 * Single chokepoint for HTTP. Owns three things kept here so iterators stay
 * focused on pagination + parsing:
 *   1. retry on 5xx with exponential backoff (RETRY_DELAYS_MS)
 *   2. surface rate-limit headers via onRateLimit on every successful response
 *   3. translate non-2xx into ProviderRateLimitError / ProviderHttpError
 *
 * Rate-limit (403 + remaining=0) is NOT retried — it's not transient on the
 * caller's timescale and the dedicated error type is more useful.
 *
 * Takes implementations of fetch and sleep to make testing easy.
 */
async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  sleep: (ms: number) => Promise<void>,
  onRateLimit: ((info: RateLimitInfo) => void) | undefined,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: requestHeaders(token) });
    if (res.ok) {
      if (onRateLimit) emitRateLimit(res, onRateLimit);
      return res;
    }
    const retryable = res.status >= 500 && res.status < 600;
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
      throw await toError(res);
    }
    // We must drain the body before discarding the response.
    await res.text().catch(() => {});
    await sleep(RETRY_DELAYS_MS[attempt] as number);
  }
}

function emitRateLimit(res: Response, onRateLimit: (info: RateLimitInfo) => void): void {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const limit = res.headers.get('x-ratelimit-limit');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining === null || limit === null || reset === null) return;
  onRateLimit({
    remaining: Number(remaining),
    limit: Number(limit),
    resetAt: new Date(Number(reset) * 1000),
  });
}

function buildSearchQuery(repo: Repo, options: ListPullsOptions): string {
  const parts: string[] = [`repo:${repo.org}/${repo.name}`, 'is:pr'];
  const state = options.state ?? 'closed';
  if (state !== 'all') parts.push(`is:${state}`);
  for (const author of options.authors ?? []) parts.push(`author:${author}`);
  if (options.since) {
    const day = options.since.toISOString().split('T')[0] as string;
    parts.push(`created:>=${day}`);
  }
  return parts.join(' ');
}

function requestHeaders(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'raepo',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function normalize(g: GhPull): PullRequest {
  return {
    number: g.number,
    title: g.title,
    author: normalizeAuthor(g.user),
    createdAt: new Date(g.created_at),
    closedAt: g.closed_at ? new Date(g.closed_at) : null,
    mergedAt: g.merged_at ? new Date(g.merged_at) : null,
    url: g.html_url,
  };
}

function normalizeSearch(g: GhSearchPull): PullRequest {
  return {
    number: g.number,
    title: g.title,
    author: normalizeAuthor(g.user),
    createdAt: new Date(g.created_at),
    closedAt: g.closed_at ? new Date(g.closed_at) : null,
    mergedAt: g.pull_request?.merged_at ? new Date(g.pull_request.merged_at) : null,
    url: g.html_url,
  };
}

function normalizeAuthor(user: GhUser): PullAuthor {
  if (!user) return { login: 'ghost', isBot: false };
  return { login: user.login, isBot: isBotUser(user) };
}

function isBotUser(user: { login: string; type?: string }): boolean {
  if (user.type === 'Bot') return true;
  return /\[bot\]$/.test(user.login) || /^(dependabot|renovate|github-actions)$/i.test(user.login);
}

/**
 * Paging support for the query results
 *
 * @param linkHeader HTTP reader
 * @returns URL
 */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return m ? (m[1] as string) : null;
}

/**
 * Provider-specific token fallback: ask the GitHub CLI (`gh`) for the user's
 * cached auth token. Returns undefined silently if `gh` isn't installed or the
 * user isn't authenticated — the CLI then proceeds unauthenticated.
 */
export async function defaultToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    const trimmed = stdout.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function toError(res: Response): Promise<Error> {
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (res.status === 403 && remaining === '0') {
    const resetUnix = res.headers.get('x-ratelimit-reset');
    const resetAt = resetUnix ? new Date(Number(resetUnix) * 1000) : null;
    const when = resetAt ? ` (resets at ${resetAt.toISOString()})` : '';
    return new ProviderRateLimitError(`GitHub API rate limit exceeded${when}`, resetAt);
  }
  if (res.status === 401) {
    return new ProviderHttpError(
      'GitHub API 401 Unauthorized — check --token, $GITHUB_TOKEN, or run `gh auth login`.',
      401,
    );
  }
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) detail = `: ${body.message}`;
  } catch {
    // body wasn't JSON; ignore
  }
  return new ProviderHttpError(`GitHub API ${res.status}${detail}`, res.status);
}

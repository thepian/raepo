/**
 * Provider abstraction. Today only `github` exists; the shape is intentionally
 * generic (no GitHub-specific fields leak through) so a future `gitlab` etc.
 * can drop in without changing callers.
 */

import type { Repo } from '../command.ts';

export type ProviderName = 'github';

export type { Repo };

export type PullAuthor = {
  login: string;
  isBot: boolean;
};

export type PullRequest = {
  number: number;
  title: string;
  author: PullAuthor;
  createdAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  url: string;
};

export type ListPullsOptions = {
  /** GitHub-style state: open | closed | all. Default: 'closed'. */
  state?: 'open' | 'closed' | 'all';
  /** When set, iteration stops as soon as a PR's createdAt falls before `since`. */
  since?: Date;
  /**
   * When provided, the provider may use a more efficient endpoint that filters
   * server-side (e.g. GitHub's search API). Caller may still filter client-side
   * for safety; the operation is idempotent.
   */
  authors?: string[];
};

export type Provider = {
  readonly name: ProviderName;
  listPulls(repo: Repo, options?: ListPullsOptions): AsyncIterable<PullRequest>;
};

export type RateLimitInfo = {
  remaining: number;
  limit: number;
  resetAt: Date;
};

export type ProviderConfig = {
  provider: ProviderName;
  token?: string;
  /** Override the global fetch — used by tests. */
  fetch?: typeof fetch;
  /** Override the sleep used between retries — used by tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once per successful response when rate-limit headers are present. */
  onRateLimit?: (info: RateLimitInfo) => void;
};

/** Thrown when the provider hits a rate limit. */
export class ProviderRateLimitError extends Error {
  override readonly name = 'ProviderRateLimitError';
  constructor(
    message: string,
    readonly resetAt: Date | null,
  ) {
    super(message);
  }
}

/** Thrown for any other non-2xx response. */
export class ProviderHttpError extends Error {
  override readonly name = 'ProviderHttpError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

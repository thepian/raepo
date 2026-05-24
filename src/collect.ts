import type { Duration, Repo } from './command.ts';
import type { ListPullsOptions, Provider, PullRequest } from './provider/types.ts';
import { DAY_MS } from './time.ts';

export type CollectOptions = {
  since?: Date;
  maxAge?: Duration;
  /** Allowlist; empty array or undefined means "all authors". */
  authors?: string[];
  /** Default false. */
  includeBots?: boolean;
  /** Called once per PR yielded by the provider, before filters are applied. */
  onProgress?: (count: number) => void;
  /** Injectable clock for tests; defaults to `new Date()`. */
  now?: Date;
};

export type CollectResult = {
  prs: PullRequest[];
  /** Total PRs received from the provider, before client-side filters. */
  fetched: number;
  /** PRs left after client-side filters. */
  filtered: number;
  /** PRs dropped because they were authored by bots (always 0 when includeBots is true). */
  botsExcluded: number;
  /** The actual `since` boundary used (computed from since + maxAge), if any. */
  effectiveSince?: Date;
};

export async function collect(
  provider: Provider,
  repo: Repo,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const since = effectiveSince(options);
  const allowlist = options.authors && options.authors.length > 0 ? new Set(options.authors) : null;
  const includeBots = options.includeBots ?? false;

  const providerOptions: ListPullsOptions = { state: 'closed' };
  if (since) providerOptions.since = since;
  if (options.authors && options.authors.length > 0) {
    providerOptions.authors = options.authors;
  }

  const out: PullRequest[] = [];
  let fetched = 0;
  let botsExcluded = 0;

  for await (const pr of provider.listPulls(repo, providerOptions)) {
    fetched += 1;
    options.onProgress?.(fetched);

    if (!includeBots && pr.author.isBot) {
      botsExcluded += 1;
      continue;
    }
    if (allowlist && !allowlist.has(pr.author.login)) continue;

    out.push(pr);
  }

  return {
    prs: out,
    fetched,
    filtered: out.length,
    botsExcluded,
    ...(since ? { effectiveSince: since } : {}),
  };
}

function effectiveSince(options: CollectOptions): Date | undefined {
  const fromMaxAge =
    options.maxAge !== undefined
      ? new Date((options.now ?? new Date()).getTime() - options.maxAge.days * DAY_MS)
      : undefined;

  if (options.since && fromMaxAge) {
    return options.since.getTime() > fromMaxAge.getTime() ? options.since : fromMaxAge;
  }
  return options.since ?? fromMaxAge;
}

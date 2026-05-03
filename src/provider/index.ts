import { createGithubProvider, defaultToken as githubDefaultToken } from './github.ts';
import type { Provider, ProviderConfig, ProviderName } from './types.ts';

/**
 * Hardcoded for now. When a second provider lands (e.g. gitlab), this becomes
 * configurable via `~/.raepo/config.json` and a `--provider` flag.
 */
export const DEFAULT_PROVIDER: ProviderName = 'github';

export function createProvider(config: ProviderConfig): Provider {
  switch (config.provider) {
    case 'github':
      return createGithubProvider(config);
  }
}

/**
 * Provider-specific token fallback chain. Each provider knows how to ask its
 * native CLI (e.g. `gh auth token` for GitHub) for a cached auth token.
 */
export async function defaultTokenFor(name: ProviderName): Promise<string | undefined> {
  switch (name) {
    case 'github':
      return githubDefaultToken();
  }
}

export type { Provider, ProviderConfig, ProviderName } from './types.ts';
export { ProviderHttpError, ProviderRateLimitError } from './types.ts';
export type { ListPullsOptions, PullAuthor, PullRequest, Repo } from './types.ts';

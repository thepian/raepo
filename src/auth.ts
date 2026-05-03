import { defaultTokenFor } from './provider/index.ts';
import type { ProviderName } from './provider/types.ts';

export type AuthEnv = { GITHUB_TOKEN?: string };

export type ResolveTokenOptions = {
  flag?: string;
  env?: AuthEnv;
  providerName?: ProviderName;
  /** Override for tests; in production defaults to the provider's native CLI fallback. */
  providerTokenFn?: (name: ProviderName) => Promise<string | undefined>;
};

/**
 * Resolution chain: --token flag → $GITHUB_TOKEN → provider's native CLI
 * (e.g. `gh auth token` for GitHub). Returns undefined if nothing yields a
 * token; the caller proceeds unauthenticated (60 req/hr on GitHub).
 */
export async function resolveToken(opts: ResolveTokenOptions): Promise<string | undefined> {
  if (opts.flag) return opts.flag;
  const envToken = opts.env?.GITHUB_TOKEN;
  if (envToken) return envToken;
  if (opts.providerName) {
    const fn = opts.providerTokenFn ?? defaultTokenFor;
    return fn(opts.providerName);
  }
  return undefined;
}

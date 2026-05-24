import { dim, yellow } from 'picocolors';
import { resolveToken } from './auth';
import { collect } from './collect';
import type { AnalyzeArgs, AnalyzeState, Command, Repo } from './command';
import { boldRed, buildError } from './command';
import { loadConfig } from './config';
import { type OutputContext, render, sortStats } from './output';
import {
  createProvider,
  DEFAULT_PROVIDER,
  ProviderHttpError,
  ProviderRateLimitError,
} from './provider';
import { byAuthor, summary } from './stats';

export function buildAnalyze(args: AnalyzeArgs, configPath?: string): Command {
  const config = loadConfig(configPath);
  if ('mode' in config) return buildError(config);

  const opts = args.options;
  const state: AnalyzeState = {
    mode: 'analyze',
    repo: args.repo,
    format: opts.format ?? config.format,
    sort: opts.sort ?? config.sort,
    includeBots: opts.includeBots ?? config.includeBots,
    authors: opts.authors,
    verbose: opts.verbose,
    since: opts.since,
    maxAge: opts.maxAge,
    limit: opts.limit,
    token: opts.token,
  };

  return {
    ...state,
    async run() {
      return runAnalyze(state);
    },
  };
}

async function runAnalyze(state: AnalyzeState): Promise<number> {
  try {
    const token = await resolveToken({
      flag: state.token,
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
      providerName: DEFAULT_PROVIDER,
    });

    const provider = createProvider({
      provider: DEFAULT_PROVIDER,
      ...(token ? { token } : {}),
      ...(state.verbose
        ? {
            onRateLimit: (info) => {
              const reset = info.resetAt.toISOString();
              const line = `rate limit: ${info.remaining}/${info.limit} (resets at ${reset})\n`;
              process.stderr.write(info.remaining < 100 ? yellow(line) : dim(line));
            },
          }
        : {}),
    });

    const showProgress = !!process.stderr.isTTY && state.format === 'plain' && !state.verbose;
    const onProgress = showProgress
      ? (count: number) => {
          process.stderr.write(`\r${dim(`fetched ${count} PRs…`)}`);
        }
      : undefined;

    const collected = await collect(provider, state.repo, {
      since: state.since,
      maxAge: state.maxAge,
      authors: state.authors,
      includeBots: state.includeBots,
      onProgress,
    });

    if (showProgress) {
      process.stderr.write(`\r\x1b[K${dim(`fetched ${collected.fetched} PRs.`)}\n`);
    }

    const sorted = sortStats(byAuthor(collected.prs), state.sort);

    const ctx: OutputContext = {
      repo: state.repo,
      since: collected.effectiveSince,
      generatedAt: new Date(),
      summary: summary(collected.prs),
      includeBots: state.includeBots,
      botsExcluded: collected.botsExcluded,
    };

    const result = render(sorted, ctx, {
      format: state.format,
      authors: state.authors,
      ...(state.limit !== undefined ? { limit: state.limit } : {}),
    });

    if (!result.ok) {
      process.stderr.write(
        `${boldRed('raepo:')} no PRs found for "${result.author}" in this window.\n`,
      );
      return 0;
    }

    process.stdout.write(result.output);
    return 0;
  } catch (err) {
    return reportError(err, state.repo);
  }
}

function reportError(err: unknown, repo: Repo): number {
  const prefix = `${boldRed('raepo:')} ${repo.org}/${repo.name}: `;
  if (err instanceof ProviderRateLimitError) {
    process.stderr.write(`${prefix}rate limit exceeded`);
    if (err.resetAt) process.stderr.write(` (resets at ${err.resetAt.toISOString()})`);
    process.stderr.write('\n');
    process.stderr.write(
      dim(
        'Hint: pass --token, set $GITHUB_TOKEN, or run `gh auth login` for higher rate limits.\n',
      ),
    );
    return 2;
  }
  if (err instanceof ProviderHttpError) {
    process.stderr.write(`${prefix}${err.message}\n`);
    return 2;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${prefix}${message}\n`);
  return 2;
}

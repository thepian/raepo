#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToken } from './auth.ts';
import { collect } from './collect.ts';
import {
  ConfigError,
  getKey,
  listEntries,
  readConfig,
  readEnv,
  resolve as resolveConfig,
  setKey,
  writeConfig,
} from './config.ts';
import type { Repo } from './domain.ts';
import { type OutputContext, render, sortStats } from './output.ts';
import type { AnalyzeOptions, ParseDefaults, ParsedArgs } from './parse.ts';
import { parseArgs } from './parse.ts';
import {
  DEFAULT_PROVIDER,
  ProviderHttpError,
  ProviderRateLimitError,
  createProvider,
} from './provider/index.ts';
import { byAuthor, summary } from './stats.ts';

const HELP = `raepo — per-author PR merge-time stats from GitHub.

Usage
  raepo <org>/<repo> [options]
  raepo config <get|set|list> [args]

Filters
  --since <date>          Only PRs created on or after <date> (YYYY-MM-DD)
  --max-age <duration>    Only PRs created within <duration> (e.g. 30d, 12w, 6mo, 1y)
  --author <list>         Restrict to author(s). Comma-separated and/or
                          repeatable: --author alice,bob --author carol
  --include-bots          Include bot accounts (excluded by default)

Output
  --format <f>            plain | json | csv  (default: plain)
  --sort <key>            merged | typical | average | tail | accept
                          (default: merged, descending)
  --limit <n>             Show top n authors (table view only)

Auth
  --token <pat>           GitHub personal access token. Resolution order:
                          --token  >  \$GITHUB_TOKEN  >  \`gh auth token\`
                          Anonymous works for public repos (60 req/hour).

Other
  --verbose, -v           Print per-request rate-limit info to stderr
  --help, -h              Show this help
  --version, -V           Show version

View modes (plain format only)
  No --author filter      Table; authors with no merged PRs go in a compact
                          "No accepted PRs" line below.
  Multiple --author       Table including every specified author (no demotion).
  Single --author         Vertical label:value detail view for that author.

Config
  raepo config get [key]  Print one key, or all set keys (key=value lines)
  raepo config set <k> <v>  Persist a default to ~/.raepo/config.json
  raepo config list       Table of key, value, source (env | config | default)

  Keys: format | sort | include-bots | concurrency
  Precedence: CLI flag > RAEPO_* env > config file > built-in default

Examples
  raepo karpathy/nanochat
  raepo karpathy/nanochat --since 2026-01-01 --limit 10
  raepo karpathy/nanochat --max-age 90d --sort typical
  raepo karpathy/nanochat --author svlandeg
  raepo karpathy/nanochat --author alice,bob,carol
  raepo karpathy/nanochat --format json | jq '.authors[]'
  GITHUB_TOKEN=ghp_xxx raepo myorg/private-repo
  raepo config set format json
`;

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

async function dispatch(parsed: ParsedArgs): Promise<number> {
  switch (parsed.mode) {
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'version':
      process.stdout.write(`${readVersion()}\n`);
      return 0;
    case 'analyze':
      return runAnalyze(parsed.repo, parsed.options);
    case 'config':
      return runConfig(parsed);
  }
}

type ConfigCmd = Extract<ParsedArgs, { mode: 'config' }>;

async function runConfig(parsed: ConfigCmd): Promise<number> {
  try {
    switch (parsed.op) {
      case 'get':
        return configGet(parsed.key);
      case 'set':
        return configSet(parsed.key, parsed.value);
      case 'list':
        return configList();
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`raepo: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function configGet(key: string | undefined): number {
  const file = readConfig();
  if (key === undefined) {
    for (const entry of listEntries(resolveConfig(file, {}))) {
      const v = getKey(file, entry.key);
      if (v !== undefined) process.stdout.write(`${entry.key}=${formatVal(v)}\n`);
    }
    return 0;
  }
  const v = getKey(file, key);
  if (v === undefined) {
    process.stderr.write(`raepo: ${key} is not set\n`);
    return 1;
  }
  process.stdout.write(`${formatVal(v)}\n`);
  return 0;
}

function configSet(key: string, value: string): number {
  const file = readConfig();
  const next = setKey(file, key, value);
  writeConfig(next);
  process.stdout.write(`${key}=${value}\n`);
  return 0;
}

function configList(): number {
  const file = readConfig();
  const env = readEnv(process.env);
  const entries = listEntries(resolveConfig(file, env));

  const headers = ['key', 'value', 'source'];
  const rows = entries.map((e) => [e.key, formatVal(e.value), e.source]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');

  process.stdout.write(`${fmt(headers)}\n`);
  process.stdout.write(
    `${'─'.repeat(widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 2)}\n`,
  );
  for (const r of rows) process.stdout.write(`${fmt(r)}\n`);
  return 0;
}

function formatVal(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

async function runAnalyze(repo: Repo, options: AnalyzeOptions): Promise<number> {
  try {
    const token = await resolveToken({
      flag: options.token,
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
      providerName: DEFAULT_PROVIDER,
    });

    const provider = createProvider({
      provider: DEFAULT_PROVIDER,
      ...(token ? { token } : {}),
      ...(options.verbose
        ? {
            onRateLimit: (info) => {
              const reset = info.resetAt.toISOString();
              process.stderr.write(
                `rate limit: ${info.remaining}/${info.limit} (resets at ${reset})\n`,
              );
            },
          }
        : {}),
    });

    // Verbose mode replaces the in-place progress counter with stable
    // per-request log lines, which would otherwise interleave with the \r.
    const showProgress = !!process.stderr.isTTY && options.format === 'plain' && !options.verbose;
    const onProgress = showProgress
      ? (count: number) => {
          process.stderr.write(`\rfetched ${count} PRs…`);
        }
      : undefined;

    const collected = await collect(provider, repo, {
      since: options.since,
      maxAge: options.maxAge,
      authors: options.authors,
      includeBots: options.includeBots,
      onProgress,
    });

    if (showProgress) {
      process.stderr.write(`\r\x1b[Kfetched ${collected.fetched} PRs.\n`);
    }

    const sorted = sortStats(byAuthor(collected.prs), options.sort);

    const ctx: OutputContext = {
      repo,
      since: collected.effectiveSince,
      generatedAt: new Date(),
      summary: summary(collected.prs),
      includeBots: options.includeBots,
      botsExcluded: collected.botsExcluded,
    };

    const result = render(sorted, ctx, {
      format: options.format,
      authors: options.authors,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });

    if (!result.ok) {
      process.stderr.write(`raepo: no PRs found for "${result.author}" in this window.\n`);
      return 0;
    }

    process.stdout.write(result.output);
    return 0;
  } catch (err) {
    return reportError(err, repo);
  }
}

function reportError(err: unknown, repo: Repo): number {
  const prefix = `raepo: ${repo.org}/${repo.name}: `;
  if (err instanceof ProviderRateLimitError) {
    process.stderr.write(`${prefix}rate limit exceeded`);
    if (err.resetAt) process.stderr.write(` (resets at ${err.resetAt.toISOString()})`);
    process.stderr.write('\n');
    process.stderr.write(
      'Hint: pass --token, set $GITHUB_TOKEN, or run `gh auth login` for higher rate limits.\n',
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

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  // Help, version, and the `config` subcommand must work even when the user's
  // ~/.raepo/config.json is malformed — `config` is how you'd diagnose that.
  // Only the analyze path layers in config-resolved defaults.
  let defaults: ParseDefaults = {};
  const isAnalyze =
    args.length > 0 &&
    args[0] !== 'config' &&
    !args.includes('--help') &&
    !args.includes('-h') &&
    !args.includes('--version') &&
    !args.includes('-V');

  if (isAnalyze) {
    try {
      const file = readConfig();
      const env = readEnv(process.env);
      const r = resolveConfig(file, env);
      defaults = {
        format: r.format.value,
        sort: r.sort.value,
        includeBots: r.includeBots.value,
      };
    } catch (e) {
      if (e instanceof ConfigError) {
        process.stderr.write(`raepo: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }

  const r = parseArgs(args, defaults);
  if (!r.ok) {
    process.stderr.write(`raepo: ${r.error.error}\n`);
    process.stderr.write('Try `raepo --help`.\n');
    return 1;
  }
  return dispatch(r.value);
}

const code = await main(process.argv);
process.exit(code);

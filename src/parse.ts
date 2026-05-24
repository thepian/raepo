/**
 * Two-phase parsing: util.parseArgs tokenises argv into typed flags +
 * positionals; valibot schemas validate and transform each value.
 *
 * util.parseArgs gives us --key=value, missing-value errors, and unknown-flag
 * errors for free. Valibot gives us type coercion and domain validation.
 * The config subcommand uses only positionals and is routed before tokenising.
 */

import { parseArgs as nodeParse } from 'node:util';
import * as v from 'valibot';
import type { AnalyzeOptions, Duration, ErrorState, ParsedArgs, Repo } from './command.ts';
import { FORMATS, SORTS } from './command.ts';
import { BUILT_IN_DEFAULTS } from './config.ts';

// --- Tokenizer options ---

const ARGV_OPTIONS = {
  strict: true,
  allowPositionals: true,
  options: {
    help: { type: 'boolean' as const, short: 'h' },
    version: { type: 'boolean' as const, short: 'V' },
    since: { type: 'string' as const },
    'max-age': { type: 'string' as const },
    author: { type: 'string' as const, multiple: true as const },
    'include-bots': { type: 'boolean' as const },
    verbose: { type: 'boolean' as const, short: 'v' },
    format: { type: 'string' as const },
    sort: { type: 'string' as const },
    limit: { type: 'string' as const },
    token: { type: 'string' as const },
  },
} as const;

// --- Validation schemas ---

const REPO_RE = /^([^/\s]+)\/([^/\s]+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION_RE = /^(\d+)(d|w|mo|y)$/;
const DURATION_UNIT_DAYS: Record<string, number> = { d: 1, w: 7, mo: 30, y: 365 };

const repoSchema = v.pipe(
  v.string(),
  v.check((s) => REPO_RE.test(s)),
  v.transform((s) => {
    const m = REPO_RE.exec(s) as RegExpExecArray;
    return { org: m[1] as string, name: m[2] as string } as Repo;
  }),
);

const dateSchema = v.pipe(
  v.string(),
  v.regex(DATE_RE, 'YYYY-MM-DD expected'),
  v.transform((s) => new Date(`${s}T00:00:00Z`)),
  v.check((d) => !Number.isNaN(d.getTime()), 'invalid date'),
);

const durationSchema = v.pipe(
  v.string(),
  v.check((s) => DURATION_RE.test(s), 'expects e.g. 30d, 12w, 6mo, 1y'),
  v.transform((s) => {
    const m = DURATION_RE.exec(s) as RegExpExecArray;
    const n = Number.parseInt(m[1] as string, 10);
    return { days: n * (DURATION_UNIT_DAYS[m[2] as string] as number) } as Duration;
  }),
);

const limitSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'must be a positive integer'),
  v.transform((s) => Number.parseInt(s, 10)),
  v.check((n) => n > 0, 'must be a positive integer'),
);

const authorsSchema = v.pipe(
  v.array(v.string()),
  v.transform((arr) =>
    arr.flatMap((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ),
  v.check((arr) => arr.length > 0, 'requires at least one non-empty login'),
);

const analyzeOptionsSchema = v.object({
  since: v.optional(dateSchema),
  'max-age': v.optional(durationSchema),
  author: v.optional(authorsSchema),
  'include-bots': v.optional(v.boolean()),
  verbose: v.optional(v.boolean()),
  format: v.optional(v.picklist(FORMATS)),
  sort: v.optional(v.picklist(SORTS)),
  limit: v.optional(limitSchema),
  token: v.optional(v.string()),
});

// --- Helpers ---

function err(message: string): ErrorState {
  return { mode: 'error', message };
}

function schemaErr(issues: v.InferIssue<typeof analyzeOptionsSchema>[]): ErrorState {
  const issue = issues[0];
  const key = issue?.path?.[0]?.key as string | undefined;
  const prefix = key ? `--${key}: ` : '';
  return err(`${prefix}${issue?.message ?? 'invalid option'}`);
}

// --- Config subcommand ---

function parseConfig(args: string[]): ParsedArgs | ErrorState {
  const op = args[0];
  if (op === undefined) {
    return err('config requires an operation: get|set|list');
  }
  switch (op) {
    case 'get': {
      if (args.length > 2) return err('too many arguments to `config get`');
      return {
        mode: 'config',
        op: 'get',
        ...(args[1] !== undefined ? { key: args[1] } : {}),
      };
    }
    case 'set': {
      if (args.length < 3) return err('config set requires <key> <value>');
      if (args.length > 3) return err('too many arguments to `config set`');
      return {
        mode: 'config',
        op: 'set',
        key: args[1] as string,
        value: args[2] as string,
      };
    }
    case 'list': {
      if (args.length > 1) return err('too many arguments to `config list`');
      return { mode: 'config', op: 'list' };
    }
    default:
      return err(`unknown config operation "${op}" (expected get|set|list)`);
  }
}

// --- Main ---

export function parseArgs(argv: string[]): ParsedArgs | ErrorState {
  if (argv.length === 0) return { mode: 'help' };
  if (argv[0] === 'config') return parseConfig(argv.slice(1));

  let tokens: ReturnType<typeof nodeParse<typeof ARGV_OPTIONS>>;
  try {
    tokens = nodeParse({ args: argv, ...ARGV_OPTIONS });
  } catch (e) {
    return err((e as Error).message);
  }

  const { values, positionals } = tokens;

  if (values.help) return { mode: 'help' };
  if (values.version) return { mode: 'version' };

  const flagResult = v.safeParse(analyzeOptionsSchema, values);
  if (!flagResult.success) return schemaErr(flagResult.issues);
  const flags = flagResult.output;

  if (positionals.length === 0) return err('expected <org>/<repo> or `config`');
  if (positionals.length > 1) return err(`unexpected positional argument: "${positionals[1]}"`);

  const repoResult = v.safeParse(repoSchema, positionals[0]);
  if (!repoResult.success) return err(`not a valid <org>/<repo>: "${positionals[0] ?? ''}"`);

  const options: AnalyzeOptions = {
    authors: flags.author ?? [],
    includeBots: flags['include-bots'],
    format: flags.format,
    sort: flags.sort,
    verbose: flags.verbose ?? false,
    since: flags.since,
    maxAge: flags['max-age'],
    limit: flags.limit,
    token: flags.token,
  };

  return { mode: 'analyze', repo: repoResult.output, options, config: BUILT_IN_DEFAULTS };
}

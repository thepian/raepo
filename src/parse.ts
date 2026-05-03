/**
 * Hand-rolled. Two alternatives if this ever needs to change:
 *
 *   - util.parseArgs (Node stdlib; Bun supports it) — would replace ~30 lines of
 *     argv walking and add --key=value for free. No supply-chain cost since it's
 *     stdlib. Doesn't know about subcommands or our ParsedArgs union.
 *   - commander / cmd-ts / mri — third-party; pay supply-chain cost for features
 *     we don't currently need (auto-help, declarative schemas).
 *
 * Most of this file is semantic validation (date, duration, enum, repo) which
 * stays either way, so a swap saves ~30 lines and not much else.
 */

import type { Duration, Format, Repo, SortKey } from './domain.ts';

export type AnalyzeOptions = {
  authors: string[];
  includeBots: boolean;
  format: Format;
  sort: SortKey;
  verbose: boolean;
  since?: Date;
  maxAge?: Duration;
  limit?: number;
  token?: string;
};

/**
 * Defaults the parser falls back to when a flag isn't passed. Production
 * callers feed config-resolved values here (env > config-file > built-in);
 * tests usually omit it and get the literal fallbacks below.
 */
export type ParseDefaults = {
  format?: Format;
  sort?: SortKey;
  includeBots?: boolean;
};

export type ParsedArgs =
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'analyze'; repo: Repo; options: AnalyzeOptions }
  | { mode: 'config'; op: 'get'; key?: string }
  | { mode: 'config'; op: 'set'; key: string; value: string }
  | { mode: 'config'; op: 'list' };

export type ParseError = { error: string; hint?: string };
export type ParseResult = { ok: true; value: ParsedArgs } | { ok: false; error: ParseError };

const FORMATS = ['plain', 'json', 'csv'] as const;
const SORTS = ['merged', 'typical', 'average', 'tail', 'accept'] as const;
const REPO_RE = /^([^/\s]+)\/([^/\s]+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION_RE = /^(\d+)(d|w|mo|y)$/;
const POSITIVE_INT_RE = /^\d+$/;
const DURATION_UNIT_DAYS: Record<string, number> = { d: 1, w: 7, mo: 30, y: 365 };

function err(message: string): ParseResult {
  return { ok: false, error: { error: message } };
}

function defaultOptions(d: ParseDefaults = {}): AnalyzeOptions {
  return {
    authors: [],
    includeBots: d.includeBots ?? false,
    format: d.format ?? 'plain',
    sort: d.sort ?? 'merged',
    verbose: false,
  };
}

function parseRepo(arg: string): Repo | null {
  const m = REPO_RE.exec(arg);
  if (!m) return null;
  return { org: m[1] as string, name: m[2] as string };
}

function parseDate(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDuration(value: string): Duration | null {
  const m = DURATION_RE.exec(value);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 10);
  const unitDays = DURATION_UNIT_DAYS[m[2] as string];
  if (unitDays === undefined) return null;
  return { days: n * unitDays };
}

function parseConfig(args: string[]): ParseResult {
  const op = args[0];
  if (op === undefined) {
    return err('config requires an operation: get|set|list');
  }
  switch (op) {
    case 'get': {
      if (args.length > 2) return err('too many arguments to `config get`');
      const result: ParsedArgs = { mode: 'config', op: 'get' };
      if (args[1] !== undefined) result.key = args[1];
      return { ok: true, value: result };
    }
    case 'set': {
      if (args.length < 3) return err('config set requires <key> <value>');
      if (args.length > 3) return err('too many arguments to `config set`');
      return {
        ok: true,
        value: { mode: 'config', op: 'set', key: args[1] as string, value: args[2] as string },
      };
    }
    case 'list': {
      if (args.length > 1) return err('too many arguments to `config list`');
      return { ok: true, value: { mode: 'config', op: 'list' } };
    }
    default:
      return err(`unknown config operation "${op}" (expected get|set|list)`);
  }
}

export function parseArgs(argv: string[], defaults: ParseDefaults = {}): ParseResult {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { ok: true, value: { mode: 'help' } };
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    return { ok: true, value: { mode: 'version' } };
  }

  if (argv[0] === 'config') {
    return parseConfig(argv.slice(1));
  }

  const options = defaultOptions(defaults);
  let repo: Repo | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;

    const value = (): { ok: true; value: string } | { ok: false; result: ParseResult } => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        return { ok: false, result: err(`${arg} requires a value`) };
      }
      return { ok: true, value: v };
    };

    const oneOf = <const T extends readonly string[]>(
      v: string,
      allowed: T,
    ): { ok: true; value: T[number] } | { ok: false; result: ParseResult } => {
      if (!(allowed as readonly string[]).includes(v)) {
        return {
          ok: false,
          result: err(`${arg} expects one of ${allowed.join('|')}; got "${v}"`),
        };
      }
      return { ok: true, value: v as T[number] };
    };

    switch (arg) {
      case '--since': {
        const v = value();
        if (!v.ok) return v.result;
        const d = parseDate(v.value);
        if (!d) return err(`--since expects YYYY-MM-DD, got "${v.value}"`);
        options.since = d;
        i += 2;
        break;
      }
      case '--max-age': {
        const v = value();
        if (!v.ok) return v.result;
        const dur = parseDuration(v.value);
        if (!dur) return err(`--max-age expects e.g. 30d, 12w, 6mo, 1y; got "${v.value}"`);
        options.maxAge = dur;
        i += 2;
        break;
      }
      case '--author': {
        const v = value();
        if (!v.ok) return v.result;
        const names = v.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (names.length === 0) {
          return err(`--author requires at least one non-empty login; got "${v.value}"`);
        }
        for (const name of names) options.authors.push(name);
        i += 2;
        break;
      }
      case '--include-bots': {
        options.includeBots = true;
        i += 1;
        break;
      }
      case '--verbose':
      case '-v': {
        options.verbose = true;
        i += 1;
        break;
      }
      case '--format': {
        const v = value();
        if (!v.ok) return v.result;
        const f = oneOf(v.value, FORMATS);
        if (!f.ok) return f.result;
        options.format = f.value;
        i += 2;
        break;
      }
      case '--sort': {
        const v = value();
        if (!v.ok) return v.result;
        const s = oneOf(v.value, SORTS);
        if (!s.ok) return s.result;
        options.sort = s.value;
        i += 2;
        break;
      }
      case '--limit': {
        const v = value();
        if (!v.ok) return v.result;
        if (!POSITIVE_INT_RE.test(v.value)) {
          return err(`--limit expects a positive integer; got "${v.value}"`);
        }
        const n = Number.parseInt(v.value, 10);
        if (n <= 0) return err(`--limit expects a positive integer; got "${v.value}"`);
        options.limit = n;
        i += 2;
        break;
      }
      case '--token': {
        const v = value();
        if (!v.ok) return v.result;
        options.token = v.value;
        i += 2;
        break;
      }
      default: {
        if (arg.startsWith('-')) {
          return err(`unknown flag: ${arg}`);
        }
        if (repo !== undefined) {
          return err(`unexpected positional argument: "${arg}"`);
        }
        const r = parseRepo(arg);
        if (!r) return err(`not a valid <org>/<repo>: "${arg}"`);
        repo = r;
        i += 1;
      }
    }
  }

  if (!repo) {
    return err('expected <org>/<repo> or `config`');
  }

  return { ok: true, value: { mode: 'analyze', repo, options } };
}

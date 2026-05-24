/**
 * Shared domain types. Owned here, imported everywhere.
 *
 * The structural shape of these is dead-simple, but centralizing the
 * declaration prevents drift — if `Repo` ever gains a third field (e.g. host
 * for GitHub Enterprise), every consumer picks it up.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, red } from 'picocolors';
import * as v from 'valibot';

export type Repo = { org: string; name: string };

export type Duration = { days: number };

export const formatSchema = v.picklist(['plain', 'json', 'csv'] as const);
export const FORMATS = formatSchema.options; // valibot picklist exposes .options
export type Format = v.InferOutput<typeof formatSchema>;

export const sortSchema = v.picklist(['merged', 'typical', 'average', 'tail', 'accept'] as const);
export const SORTS = sortSchema.options;
export type SortKey = v.InferOutput<typeof sortSchema>;

export type ConfigValues = {
  format: Format;
  sort: SortKey;
  includeBots: boolean;
  concurrency: number;
};

export type ErrorState = { mode: 'error'; message: string };

export type AnalyzeOptions = {
  authors: string[];
  verbose: boolean;
  /** Undefined when --format was not passed; caller merges config/built-in default. */
  format?: Format;
  /** Undefined when --sort was not passed; caller merges config/built-in default. */
  sort?: SortKey;
  /** Undefined when --include-bots was not passed; caller merges config/built-in default. */
  includeBots?: boolean;
  since?: Date;
  maxAge?: Duration;
  limit?: number;
  token?: string;
};

export type AnalyzeArgs = {
  mode: 'analyze';
  repo: Repo;
  options: AnalyzeOptions;
  config: ConfigValues;
};
export type ParsedArgs =
  | { mode: 'help' }
  | { mode: 'version' }
  | AnalyzeArgs
  | { mode: 'config'; op: 'get'; key?: string }
  | { mode: 'config'; op: 'set'; key: string; value: string }
  | { mode: 'config'; op: 'list' };

// AnalyzeOptions content must be here. No readable way to declare the dependency. Optionality is different.
export type AnalyzeState = {
  mode: 'analyze';
  repo: Repo;
  format: Format;
  sort: SortKey;
  includeBots: boolean;
  authors: string[];
  verbose: boolean;
  since?: Date;
  maxAge?: Duration;
  limit?: number;
  token?: string;
};

export type ConfigState = Extract<ParsedArgs, { mode: 'config' }>;

export type Command =
  | { mode: 'help'; run(): Promise<number> }
  | { mode: 'version'; run(): Promise<number> }
  | (AnalyzeState & { run(): Promise<number> })
  | (ConfigState & { run(): Promise<number> })
  | (ErrorState & { run(): Promise<number> });

export function buildError(err: ErrorState): Command {
  return {
    ...err,
    async run() {
      process.stderr.write(`${boldRed('raepo:')} ${err.message}\n`);
      process.stderr.write(dim('Try `raepo --help`.\n'));
      return 1;
    },
  };
}

export function buildVersion(_: ParsedArgs): Command {
  return {
    mode: 'version',
    async run() {
      process.stdout.write(`${readVersion()}\n`);
      return 0;
    },
  };
}

export const boldRed = (s: string) => bold(red(s));

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

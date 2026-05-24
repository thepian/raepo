/**
 * Config skeleton: file at `~/.raepo/config.json`, kebab-key schema, and a
 * pure resolver layering env > file > built-in default.
 *
 * Tokens are deliberately NOT a config key — keep them in `$GITHUB_TOKEN` or
 * `gh auth token` so they don't sit on disk.
 *
 * `concurrency` is reserved for a future parallel-fetch path; the schema
 * accepts it today so users can persist it without a future migration, but
 * nothing in the current analyze pipeline reads it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { bold, cyan, dim } from 'picocolors';
import * as v from 'valibot';
import {
  boldRed,
  buildError,
  type Command,
  type ConfigState,
  type ConfigValues,
  type ErrorState,
  type Format,
  formatSchema,
  type ParsedArgs,
  type SortKey,
  sortSchema,
} from './command.ts';

export const CONFIG_DIR = join(homedir(), '.raepo');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export const BUILT_IN_DEFAULTS: ConfigValues = {
  format: 'plain',
  sort: 'merged',
  includeBots: false,
  concurrency: 4,
};

export type Source = 'env' | 'config' | 'default';

export type Resolved = {
  [K in keyof ConfigValues]: { value: ConfigValues[K]; source: Source };
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type ConfigFile = Partial<ConfigValues> & { version?: number };

// --- Schemas — single source of truth for valid values and coercion ---

// Accepts JSON boolean or string "true"/"false" (env vars).
const boolCoerceSchema = v.union(
  [
    v.boolean(),
    v.pipe(
      v.picklist(['true', 'false'] as const),
      v.transform((s) => s === 'true'),
    ),
  ],
  'must be true or false',
);

// Accepts JSON number or digit string (env vars).
const positiveIntSchema = v.union(
  [
    v.pipe(v.number(), v.integer(), v.minValue(1)),
    v.pipe(
      v.string(),
      v.regex(/^\d+$/),
      v.transform((s) => Number.parseInt(s, 10)),
      v.check((n) => n > 0),
    ),
  ],
  'must be a positive integer',
);

type AnySchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

// Single source of truth: dashed key, camelCase field, validation schema.
const CONFIG_ENTRIES = [
  { key: 'format', field: 'format', schema: formatSchema },
  { key: 'sort', field: 'sort', schema: sortSchema },
  { key: 'include-bots', field: 'includeBots', schema: boolCoerceSchema },
  { key: 'concurrency', field: 'concurrency', schema: positiveIntSchema },
] as const satisfies ReadonlyArray<{ key: string; field: keyof ConfigValues; schema: AnySchema }>;

export type ConfigKey = (typeof CONFIG_ENTRIES)[number]['key'];
/** User-facing key names (kebab; match the file + the future `--<key>` flags). */
export const CONFIG_KEYS = CONFIG_ENTRIES.map((e) => e.key) as readonly ConfigKey[];

// --- Public API ---

/** Read & validate the config file. Returns {} when the file is absent. */
export function readConfig(path: string = CONFIG_PATH): ConfigFile {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`failed to parse ${path}: ${(e as Error).message}`);
  }
  return validate(raw);
}

/** Write the config file, creating the parent dir if needed. Always stamps version: 1. */
export function writeConfig(file: ConfigFile, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const serializable: Record<string, unknown> = { version: 1 };
  for (const { key, field } of CONFIG_ENTRIES) {
    const val = file[field];
    if (val !== undefined) serializable[key] = val;
  }
  writeFileSync(path, `${JSON.stringify(serializable, null, 2)}\n`);
}

/** Validate a parsed JSON value as a config object. Throws ConfigError on bad shape. */
export function validate(raw: unknown): ConfigFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config: expected a JSON object');
  }
  return Object.entries(raw as Record<string, unknown>).reduce<ConfigFile>((out, [k, val]) => {
    if (k === 'version') {
      if (val !== 1)
        throw new ConfigError(`config: unsupported version ${JSON.stringify(val)} (expected 1)`);
      return Object.assign(out, { version: 1 as const });
    }
    const entry = CONFIG_ENTRIES.find((e) => e.key === k);
    if (!entry) {
      throw new ConfigError(`config: unknown key "${k}" (allowed: ${CONFIG_KEYS.join(', ')})`);
    }
    const result = v.safeParse(entry.schema, val);
    if (!result.success) {
      throw new ConfigError(`config: ${k}: ${result.issues[0]?.message ?? 'invalid value'}`);
    }
    return Object.assign(out, { [entry.field]: result.output });
  }, {});
}

function parseField(key: ConfigKey, raw: unknown): Format | SortKey | boolean | number {
  const entry = CONFIG_ENTRIES.find((e) => e.key === key);
  if (!entry) throw new ConfigError(`config: internal error: unknown key "${key}"`);
  const result = v.safeParse(entry.schema, raw);
  if (!result.success) {
    throw new ConfigError(`config: ${key}: ${result.issues[0]?.message ?? 'invalid value'}`);
  }
  return result.output as Format | SortKey | boolean | number;
}

/** Read RAEPO_* env vars into a partial config. Throws ConfigError on bad values. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): Partial<ConfigValues> {
  const out: Partial<ConfigValues> = {};
  if (env.RAEPO_FORMAT !== undefined) out.format = parseField('format', env.RAEPO_FORMAT) as Format;
  if (env.RAEPO_SORT !== undefined) out.sort = parseField('sort', env.RAEPO_SORT) as SortKey;
  if (env.RAEPO_INCLUDE_BOTS !== undefined) {
    out.includeBots = parseField('include-bots', env.RAEPO_INCLUDE_BOTS) as boolean;
  }
  if (env.RAEPO_CONCURRENCY !== undefined) {
    out.concurrency = parseField('concurrency', env.RAEPO_CONCURRENCY) as number;
  }
  return out;
}

/**
 * Precedence: env > config file > built-in default. CLI flags layer on top in
 * the parser (they enter as overrides of the defaults this returns).
 */
export function resolve(file: Partial<ConfigValues>, env: Partial<ConfigValues>): Resolved {
  return {
    format: pick(env.format, file.format, BUILT_IN_DEFAULTS.format),
    sort: pick(env.sort, file.sort, BUILT_IN_DEFAULTS.sort),
    includeBots: pick(env.includeBots, file.includeBots, BUILT_IN_DEFAULTS.includeBots),
    concurrency: pick(env.concurrency, file.concurrency, BUILT_IN_DEFAULTS.concurrency),
  };
}

/** Strip sources, return just the values. */
export function values(r: Resolved): ConfigValues {
  return {
    format: r.format.value,
    sort: r.sort.value,
    includeBots: r.includeBots.value,
    concurrency: r.concurrency.value,
  };
}

/** List entries in display order with kebab keys — used by `config list`. */
export function listEntries(
  r: Resolved,
): Array<{ key: ConfigKey; value: ConfigValues[keyof ConfigValues]; source: Source }> {
  return CONFIG_ENTRIES.map(({ key, field }) => {
    const cell = r[field];
    return { key, value: cell.value, source: cell.source };
  });
}

/** Apply a single (kebab key, raw value) update to a config object. Throws on bad key/value. */
export function setKey(file: ConfigFile, key: string, raw: string): ConfigFile {
  const entry = CONFIG_ENTRIES.find((e) => e.key === key);
  if (!entry) {
    throw new ConfigError(`config: unknown key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`);
  }
  const result = v.safeParse(entry.schema, raw);
  if (!result.success) {
    throw new ConfigError(`config: ${key}: ${result.issues[0]?.message ?? 'invalid value'}`);
  }
  return { ...file, [entry.field]: result.output };
}

/** Read a single key from a stored file. Returns undefined when unset. */
export function getKey(file: ConfigFile, key: string): unknown {
  const entry = CONFIG_ENTRIES.find((e) => e.key === key);
  if (!entry) {
    throw new ConfigError(`unknown config key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`);
  }
  return file[entry.field];
}

function pick<T>(
  envVal: T | undefined,
  fileVal: T | undefined,
  def: T,
): { value: T; source: Source } {
  if (envVal !== undefined) return { value: envVal, source: 'env' };
  if (fileVal !== undefined) return { value: fileVal, source: 'config' };
  return { value: def, source: 'default' };
}

// --- State layer functions ---

export function loadConfig(configPath?: string): ConfigValues | ErrorState {
  try {
    return values(resolve(readConfig(configPath), readEnv(process.env)));
  } catch (e) {
    return { mode: 'error', message: (e as ConfigError).message };
  }
}

function configGet(state: Extract<ConfigState, { op: 'get' }>, configPath?: string): number {
  const { key } = state;
  const file = readConfig(configPath);
  if (key === undefined) {
    for (const entry of CONFIG_ENTRIES) {
      const v = getKey(file, entry.key);
      if (v !== undefined) process.stdout.write(`${entry.key}=${formatVal(v)}\n`);
    }
    return 0;
  }
  const v = getKey(file, key);
  if (v === undefined) {
    process.stderr.write(`${boldRed('raepo:')} ${key} is not set\n`);
    return 1;
  }
  process.stdout.write(`${formatVal(v)}\n`);
  return 0;
}

function configSet(state: Extract<ConfigState, { op: 'set' }>, configPath?: string): number {
  const { key, value } = state;
  const file = readConfig(configPath);
  const next = setKey(file, key, value);
  writeConfig(next, configPath);
  process.stdout.write(`${key}=${value}\n`);
  return 0;
}

function configList(_state: Extract<ConfigState, { op: 'list' }>, configPath?: string): number {
  const file = readConfig(configPath);
  const env = readEnv(process.env);
  const entries = listEntries(resolve(file, env));

  const headers = ['key', 'value', 'source'];
  const rows = entries.map((e) => [e.key, formatVal(e.value), e.source]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const pad = (cells: string[]): string[] => cells.map((c, i) => c.padEnd(widths[i] ?? c.length));

  process.stdout.write(`${pad(headers).map(bold).join('  ')}\n`);
  process.stdout.write(
    `${dim('─'.repeat(widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 2))}\n`,
  );
  for (const r of rows) {
    const padded = pad(r);
    const source = r[2] ?? '';
    const sourceCell = padded[2] ?? '';
    const styledSource =
      source === 'env' ? cyan(sourceCell) : source === 'default' ? dim(sourceCell) : sourceCell;
    process.stdout.write(`${padded[0]}  ${padded[1]}  ${styledSource}\n`);
  }
  return 0;
}

function formatVal(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function buildConfig(args: ParsedArgs, configPath?: string): Command {
  const config = loadConfig(configPath);
  if ('mode' in config) return buildError(config);
  const state = args as ConfigState;
  const run = async (): Promise<number> => {
    try {
      switch (state.op) {
        case 'get':
          return configGet(state, configPath);
        case 'set':
          return configSet(state, configPath);
        case 'list':
          return configList(state, configPath);
      }
    } catch (e) {
      if (e instanceof ConfigError) {
        process.stderr.write(`${boldRed('raepo:')} ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    return 0; // unreachable, but catchall in case of future changes.
  };
  return { ...(state as object), run } as Command;
}

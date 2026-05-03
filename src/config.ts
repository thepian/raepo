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
import type { Format, SortKey } from './domain.ts';

export const CONFIG_DIR = join(homedir(), '.raepo');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const FORMATS: readonly Format[] = ['plain', 'json', 'csv'];
const SORTS: readonly SortKey[] = ['merged', 'typical', 'average', 'tail', 'accept'];

/** User-facing key names (kebab; match the file + the future `--<key>` flags). */
export const CONFIG_KEYS = ['format', 'sort', 'include-bots', 'concurrency'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export type ConfigValues = {
  format: Format;
  sort: SortKey;
  includeBots: boolean;
  concurrency: number;
};

/** Maps the user-facing kebab key to the camel field used internally. */
const KEY_FIELD: Record<ConfigKey, keyof ConfigValues> = {
  format: 'format',
  sort: 'sort',
  'include-bots': 'includeBots',
  concurrency: 'concurrency',
};

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

export type ConfigFile = Partial<ConfigValues> & { version?: number };

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

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
  const out: ConfigFile = { version: 1, ...file };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}

/** Validate a parsed JSON value as a config object. Throws ConfigError on bad shape. */
export function validate(raw: unknown): ConfigFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config: expected a JSON object');
  }
  const out: ConfigFile = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'version') {
      if (v !== 1) {
        throw new ConfigError(`config: unsupported version ${JSON.stringify(v)} (expected 1)`);
      }
      out.version = 1;
      continue;
    }
    assignFromKebab(out, k, v);
  }
  return out;
}

/** Apply a (kebab key, raw value) pair to a ConfigFile, dispatching by key for type safety. */
function assignFromKebab(out: ConfigFile, key: string, raw: unknown): void {
  switch (key) {
    case 'format':
      out.format = coerce('format', raw);
      return;
    case 'sort':
      out.sort = coerce('sort', raw);
      return;
    case 'include-bots':
      out.includeBots = coerce('include-bots', raw);
      return;
    case 'concurrency':
      out.concurrency = coerce('concurrency', raw);
      return;
    default:
      throw new ConfigError(`config: unknown key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`);
  }
}

/** Coerce a raw value (typically a string from CLI/env/file) to the typed value for `key`. */
export function coerce(key: 'format', raw: unknown): Format;
export function coerce(key: 'sort', raw: unknown): SortKey;
export function coerce(key: 'include-bots', raw: unknown): boolean;
export function coerce(key: 'concurrency', raw: unknown): number;
export function coerce(key: ConfigKey, raw: unknown): Format | SortKey | boolean | number;
export function coerce(key: ConfigKey, raw: unknown): Format | SortKey | boolean | number {
  switch (key) {
    case 'format': {
      const s = String(raw);
      if (!(FORMATS as readonly string[]).includes(s)) {
        throw new ConfigError(`config: format must be one of ${FORMATS.join('|')}; got "${s}"`);
      }
      return s as Format;
    }
    case 'sort': {
      const s = String(raw);
      if (!(SORTS as readonly string[]).includes(s)) {
        throw new ConfigError(`config: sort must be one of ${SORTS.join('|')}; got "${s}"`);
      }
      return s as SortKey;
    }
    case 'include-bots': {
      if (raw === true || raw === false) return raw;
      const s = String(raw).toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      throw new ConfigError(`config: include-bots must be true|false; got "${raw}"`);
    }
    case 'concurrency': {
      let n: number;
      if (typeof raw === 'number') {
        n = raw;
      } else {
        // parseInt('1.5') === 1 — guard with a strict regex first.
        const s = String(raw);
        if (!/^\d+$/.test(s)) {
          throw new ConfigError(`config: concurrency must be a positive integer; got "${raw}"`);
        }
        n = Number.parseInt(s, 10);
      }
      if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(`config: concurrency must be a positive integer; got "${raw}"`);
      }
      return n;
    }
  }
}

/** Read RAEPO_* env vars into a partial config. Throws ConfigError on bad values. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): Partial<ConfigValues> {
  const out: Partial<ConfigValues> = {};
  if (env.RAEPO_FORMAT !== undefined) out.format = coerce('format', env.RAEPO_FORMAT);
  if (env.RAEPO_SORT !== undefined) out.sort = coerce('sort', env.RAEPO_SORT);
  if (env.RAEPO_INCLUDE_BOTS !== undefined) {
    out.includeBots = coerce('include-bots', env.RAEPO_INCLUDE_BOTS);
  }
  if (env.RAEPO_CONCURRENCY !== undefined) {
    out.concurrency = coerce('concurrency', env.RAEPO_CONCURRENCY);
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
  return CONFIG_KEYS.map((key) => {
    const field = KEY_FIELD[key];
    const cell = r[field];
    return { key, value: cell.value, source: cell.source };
  });
}

/** Apply a single (kebab key, raw value) update to a config object. Throws on bad key/value. */
export function setKey(file: ConfigFile, key: string, raw: string): ConfigFile {
  const next: ConfigFile = { ...file };
  assignFromKebab(next, key, raw);
  return next;
}

/** Read a single key from a stored file. Returns undefined when unset. */
export function getKey(file: ConfigFile, key: string): unknown {
  if (!isConfigKey(key)) {
    throw new ConfigError(`unknown config key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`);
  }
  return file[KEY_FIELD[key]];
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

function isConfigKey(s: string): s is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(s);
}

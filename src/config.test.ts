import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILT_IN_DEFAULTS,
  ConfigError,
  coerce,
  getKey,
  listEntries,
  readConfig,
  readEnv,
  resolve,
  setKey,
  validate,
  values,
  writeConfig,
} from './config.ts';

describe('config — coerce', () => {
  it('parses format', () => {
    expect(coerce('format', 'json')).toBe('json');
  });
  it('rejects unknown format', () => {
    expect(() => coerce('format', 'xml')).toThrow(/format/);
  });
  it('parses sort', () => {
    expect(coerce('sort', 'typical')).toBe('typical');
  });
  it('rejects unknown sort', () => {
    expect(() => coerce('sort', 'name')).toThrow(/sort/);
  });
  it('parses include-bots from string and boolean', () => {
    expect(coerce('include-bots', 'true')).toBe(true);
    expect(coerce('include-bots', 'false')).toBe(false);
    expect(coerce('include-bots', true)).toBe(true);
    expect(coerce('include-bots', false)).toBe(false);
  });
  it('rejects invalid include-bots', () => {
    expect(() => coerce('include-bots', 'yes')).toThrow(/include-bots/);
  });
  it('parses positive-integer concurrency', () => {
    expect(coerce('concurrency', '4')).toBe(4);
    expect(coerce('concurrency', 8)).toBe(8);
  });
  it.each(['0', '-1', '1.5', 'abc'])('rejects bad concurrency value: %s', (v) => {
    expect(() => coerce('concurrency', v)).toThrow(/concurrency/);
  });
});

describe('config — validate', () => {
  it('accepts a valid object', () => {
    expect(validate({ version: 1, format: 'json', sort: 'typical' })).toEqual({
      version: 1,
      format: 'json',
      sort: 'typical',
    });
  });
  it('maps the kebab key include-bots to includeBots', () => {
    expect(validate({ 'include-bots': true })).toEqual({ includeBots: true });
  });
  it('rejects unknown keys with a list of allowed keys', () => {
    expect(() => validate({ foo: 'bar' })).toThrow(/foo|allowed/);
  });
  it('rejects unsupported version', () => {
    expect(() => validate({ version: 2 })).toThrow(/version/);
  });
  it('rejects non-objects', () => {
    expect(() => validate(null)).toThrow(ConfigError);
    expect(() => validate([])).toThrow(ConfigError);
    expect(() => validate('hello')).toThrow(ConfigError);
  });
});

describe('config — readEnv', () => {
  it('reads RAEPO_* vars', () => {
    expect(readEnv({ RAEPO_FORMAT: 'csv', RAEPO_SORT: 'tail' } as NodeJS.ProcessEnv)).toEqual({
      format: 'csv',
      sort: 'tail',
    });
  });
  it('returns empty when no RAEPO_* vars are set', () => {
    expect(readEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });
  it('rejects bad values', () => {
    expect(() => readEnv({ RAEPO_SORT: 'bogus' } as NodeJS.ProcessEnv)).toThrow(/sort/);
  });
});

describe('config — resolve', () => {
  it('uses built-in defaults when nothing is set', () => {
    const r = resolve({}, {});
    expect(values(r)).toEqual(BUILT_IN_DEFAULTS);
    expect(r.format.source).toBe('default');
    expect(r.concurrency.source).toBe('default');
  });
  it('prefers config file over default', () => {
    const r = resolve({ format: 'json' }, {});
    expect(r.format).toEqual({ value: 'json', source: 'config' });
    expect(r.sort.source).toBe('default');
  });
  it('prefers env over config file', () => {
    const r = resolve({ format: 'csv' }, { format: 'json' });
    expect(r.format).toEqual({ value: 'json', source: 'env' });
  });
});

describe('config — listEntries', () => {
  it('returns kebab keys in display order with their values & sources', () => {
    const r = resolve({ format: 'json' }, {});
    expect(listEntries(r)).toEqual([
      { key: 'format', value: 'json', source: 'config' },
      { key: 'sort', value: 'merged', source: 'default' },
      { key: 'include-bots', value: false, source: 'default' },
      { key: 'concurrency', value: 4, source: 'default' },
    ]);
  });
});

describe('config — setKey / getKey', () => {
  it('setKey adds a new key', () => {
    expect(setKey({}, 'format', 'json')).toEqual({ format: 'json' });
  });
  it('setKey overrides an existing key', () => {
    expect(setKey({ format: 'csv' }, 'format', 'json')).toEqual({ format: 'json' });
  });
  it('setKey maps include-bots to includeBots', () => {
    expect(setKey({}, 'include-bots', 'true')).toEqual({ includeBots: true });
  });
  it('setKey rejects unknown keys', () => {
    expect(() => setKey({}, 'foo', 'bar')).toThrow(/foo|allowed/);
  });
  it('getKey reads from the camel field', () => {
    expect(getKey({ format: 'json' }, 'format')).toBe('json');
  });
  it('getKey returns undefined when unset', () => {
    expect(getKey({}, 'format')).toBeUndefined();
  });
  it('getKey rejects unknown keys', () => {
    expect(() => getKey({}, 'foo')).toThrow(/foo|allowed/);
  });
});

describe('config — readConfig / writeConfig', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = `${tmpdir()}/raepo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    path = join(dir, 'subdir', 'config.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when the file is absent', () => {
    expect(readConfig(path)).toEqual({});
  });

  it('writeConfig creates parent dirs and stamps version: 1', () => {
    writeConfig({ format: 'json', sort: 'typical' }, path);
    expect(readConfig(path)).toEqual({ version: 1, format: 'json', sort: 'typical' });
  });

  it('throws ConfigError on malformed JSON', () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    expect(() => readConfig(path)).toThrow(ConfigError);
  });
});

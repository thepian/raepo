import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_DEFAULTS,
  buildConfig,
  ConfigError,
  getKey,
  listEntries,
  loadConfig,
  readConfig,
  readEnv,
  resolve,
  setKey,
  validate,
  values,
  writeConfig,
} from '../../src/config.ts';

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
    expect(validate({ 'include-bots': false })).toEqual({ includeBots: false });
  });
  it('accepts concurrency as a number', () => {
    expect(validate({ concurrency: 4 })).toEqual({ concurrency: 4 });
  });
  it('rejects invalid format', () => {
    expect(() => validate({ format: 'xml' })).toThrow(/format/);
  });
  it('rejects invalid sort', () => {
    expect(() => validate({ sort: 'name' })).toThrow(/sort/);
  });
  it('rejects invalid include-bots', () => {
    expect(() => validate({ 'include-bots': 'yes' })).toThrow(/include-bots/);
  });
  it.each([0, -1, 1.5])('rejects bad concurrency value: %s', (n) => {
    expect(() => validate({ concurrency: n })).toThrow(/concurrency/);
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
  it('setKey rejects invalid format', () => {
    expect(() => setKey({}, 'format', 'xml')).toThrow(/format/);
  });
  it('setKey rejects invalid sort', () => {
    expect(() => setKey({}, 'sort', 'name')).toThrow(/sort/);
  });
  it('setKey rejects invalid include-bots', () => {
    expect(() => setKey({}, 'include-bots', 'yes')).toThrow(/include-bots/);
  });
  it.each(['0', '-1', '1.5', 'abc'])('setKey rejects bad concurrency: %s', (v) => {
    expect(() => setKey({}, 'concurrency', v)).toThrow(/concurrency/);
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
  it('round-trips includeBots through write→read', () => {
    writeConfig({ includeBots: true }, path);
    expect(readConfig(path)).toEqual({ version: 1, includeBots: true });
  });

  it('throws ConfigError on malformed JSON', () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    expect(() => readConfig(path)).toThrow(ConfigError);
  });
});

describe('config — loadConfig', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raepo-lc-'));
    path = join(dir, 'config.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns built-in defaults when file is absent and no env vars', () => {
    const result = loadConfig(path);
    expect(result).toEqual(BUILT_IN_DEFAULTS);
  });

  it('merges file over defaults', () => {
    writeConfig({ format: 'json' }, path);
    const result = loadConfig(path);
    expect(result).toMatchObject({ format: 'json', sort: 'merged' });
  });

  it('returns ErrorState when file is malformed', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'not json');
    const result = loadConfig(path);
    expect(result).toMatchObject({ mode: 'error' });
  });
});

describe('config commands — buildConfig', () => {
  let dir: string;
  let path: string;
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raepo-cmd-'));
    path = join(dir, 'config.json');
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('buildConfig returns error command when config file is malformed', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'not json');
    const cmd = buildConfig({ mode: 'config', op: 'list' }, path);
    expect(cmd.mode).toBe('error');
    const code = await cmd.run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/raepo:/);
  });

  it('config get with no key shows only explicitly-set keys', async () => {
    writeConfig({ format: 'json' }, path);
    const code = await buildConfig({ mode: 'config', op: 'get' }, path).run();
    expect(code).toBe(0);
    expect(stdout).toBe('format=json\n');
  });

  it('config get with no key shows nothing when file is empty', async () => {
    const code = await buildConfig({ mode: 'config', op: 'get' }, path).run();
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('config get with key prints the value', async () => {
    writeConfig({ format: 'csv' }, path);
    const code = await buildConfig({ mode: 'config', op: 'get', key: 'format' }, path).run();
    expect(code).toBe(0);
    expect(stdout).toBe('csv\n');
  });

  it('config get with key returns 1 and errors when key is not set', async () => {
    const code = await buildConfig({ mode: 'config', op: 'get', key: 'format' }, path).run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/format.*not set/);
  });

  it('config set writes the key and prints key=value', async () => {
    const code = await buildConfig(
      { mode: 'config', op: 'set', key: 'format', value: 'json' },
      path,
    ).run();
    expect(code).toBe(0);
    expect(stdout).toBe('format=json\n');
    expect(readConfig(path)).toMatchObject({ format: 'json' });
  });

  it('config set updates an existing key without clobbering others', async () => {
    writeConfig({ format: 'csv', sort: 'tail' }, path);
    await buildConfig({ mode: 'config', op: 'set', key: 'format', value: 'json' }, path).run();
    expect(readConfig(path)).toMatchObject({ format: 'json', sort: 'tail' });
  });

  it('config set returns 1 and errors on an invalid value', async () => {
    const code = await buildConfig(
      { mode: 'config', op: 'set', key: 'format', value: 'xml' },
      path,
    ).run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/format/);
  });

  it('config list prints all keys with headers', async () => {
    writeConfig({ format: 'json' }, path);
    const code = await buildConfig({ mode: 'config', op: 'list' }, path).run();
    expect(code).toBe(0);
    expect(stdout).toMatch(/key.*value.*source/i);
    expect(stdout).toMatch(/format.*json.*config/);
    expect(stdout).toMatch(/sort.*merged.*default/);
  });

  it('config list includes-bots shows false by default', async () => {
    const code = await buildConfig({ mode: 'config', op: 'list' }, path).run();
    expect(code).toBe(0);
    expect(stdout).toMatch(/include-bots.*false/);
  });
});

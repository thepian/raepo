import { describe, expect, it } from 'vitest';
import { BUILT_IN_DEFAULTS } from '../../src/config.ts';
import { parseArgs } from '../../src/parse.ts';

describe('parseArgs — mode detection', () => {
  it('returns help mode when called with no arguments', () => {
    expect(parseArgs([])).toEqual({ mode: 'help' });
  });

  it('returns help mode for --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ mode: 'help' });
    expect(parseArgs(['-h'])).toEqual({ mode: 'help' });
  });

  it('returns version mode for --version and -V', () => {
    expect(parseArgs(['--version'])).toEqual({ mode: 'version' });
    expect(parseArgs(['-V'])).toEqual({ mode: 'version' });
  });
});

describe('parseArgs — analyze mode', () => {
  it('parses <org>/<repo> and leaves config-influenced flags undefined', () => {
    const r = parseArgs(['karpathy/nanochat']);
    expect(r).toEqual({
      mode: 'analyze',
      repo: { org: 'karpathy', name: 'nanochat' },
      options: {
        authors: [],
        includeBots: undefined,
        format: undefined,
        sort: undefined,
        verbose: false,
      },
      config: BUILT_IN_DEFAULTS,
    });
  });
});

describe('parseArgs — --verbose', () => {
  it('flips the default to true with --verbose', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--verbose']));
    expect(opts.verbose).toBe(true);
  });

  it('accepts the short form -v', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '-v']));
    expect(opts.verbose).toBe(true);
  });
});

function analyzeOptions(r: ReturnType<typeof parseArgs>) {
  if (r.mode === 'error') throw new Error(`expected ok result, got error: ${r.message}`);
  if (r.mode !== 'analyze') throw new Error(`expected analyze mode, got ${r.mode}`);
  return r.options;
}

describe('parseArgs — --since', () => {
  it('parses YYYY-MM-DD into a Date at UTC midnight', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--since', '2026-01-15']));
    expect(opts.since).toEqual(new Date('2026-01-15T00:00:00Z'));
  });

  it('errors on a missing value', () => {
    const r = parseArgs(['karpathy/nanochat', '--since']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--since/);
  });

  it('errors on a non-date value', () => {
    const r = parseArgs(['karpathy/nanochat', '--since', 'not-a-date']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/YYYY-MM-DD/);
  });

  it('errors on an out-of-range month', () => {
    const r = parseArgs(['karpathy/nanochat', '--since', '2026-13-01']);
    expect(r.mode).toBe('error');
  });
});

describe('parseArgs — --max-age', () => {
  it.each([
    ['30d', 30],
    ['12w', 84],
    ['6mo', 180],
    ['1y', 365],
  ])('parses %s into %d days', (input, days) => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--max-age', input]));
    expect(opts.maxAge).toEqual({ days });
  });

  it('errors on a missing value', () => {
    const r = parseArgs(['karpathy/nanochat', '--max-age']);
    expect(r.mode).toBe('error');
  });

  it('errors on an unknown unit', () => {
    const r = parseArgs(['karpathy/nanochat', '--max-age', '30x']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--max-age/);
  });
});

describe('parseArgs — --author', () => {
  it('captures a single author', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--author', 'alice']));
    expect(opts.authors).toEqual(['alice']);
  });

  it('is repeatable', () => {
    const opts = analyzeOptions(
      parseArgs(['karpathy/nanochat', '--author', 'alice', '--author', 'bob']),
    );
    expect(opts.authors).toEqual(['alice', 'bob']);
  });

  it('accepts comma-separated logins in one flag', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--author', 'alice,bob,carol']));
    expect(opts.authors).toEqual(['alice', 'bob', 'carol']);
  });

  it('trims whitespace within comma-separated lists', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--author', 'alice, bob , carol']));
    expect(opts.authors).toEqual(['alice', 'bob', 'carol']);
  });

  it('combines repeated flags and comma-separated lists', () => {
    const opts = analyzeOptions(
      parseArgs(['karpathy/nanochat', '--author', 'alice,bob', '--author', 'carol']),
    );
    expect(opts.authors).toEqual(['alice', 'bob', 'carol']);
  });

  it('drops empty segments from comma-separated lists', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--author', 'alice,,bob']));
    expect(opts.authors).toEqual(['alice', 'bob']);
  });

  it('errors when a comma-only value yields no logins', () => {
    const r = parseArgs(['karpathy/nanochat', '--author', ',,,']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--author/);
  });

  it('errors on a missing value', () => {
    const r = parseArgs(['karpathy/nanochat', '--author']);
    expect(r.mode).toBe('error');
  });
});

describe('parseArgs — --include-bots', () => {
  it('flips the default to true when present', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--include-bots']));
    expect(opts.includeBots).toBe(true);
  });
});

describe('parseArgs — --format', () => {
  it.each(['plain', 'json', 'csv'] as const)('accepts %s', (format) => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--format', format]));
    expect(opts.format).toBe(format);
  });

  it('errors on an unknown value', () => {
    const r = parseArgs(['karpathy/nanochat', '--format', 'xml']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--format/);
  });
});

describe('parseArgs — --sort', () => {
  it.each(['merged', 'typical', 'average', 'tail', 'accept'] as const)('accepts %s', (sort) => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--sort', sort]));
    expect(opts.sort).toBe(sort);
  });

  it('errors on an unknown value', () => {
    const r = parseArgs(['karpathy/nanochat', '--sort', 'name']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--sort/);
  });
});

describe('parseArgs — --limit', () => {
  it('parses a positive integer', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--limit', '10']));
    expect(opts.limit).toBe(10);
  });

  it.each(['0', '-3', 'abc', '1.5'])('errors on "%s"', (value) => {
    const r = parseArgs(['karpathy/nanochat', '--limit', value]);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--limit/);
  });
});

describe('parseArgs — --token', () => {
  it('captures the token value', () => {
    const opts = analyzeOptions(parseArgs(['karpathy/nanochat', '--token', 'ghp_secret']));
    expect(opts.token).toBe('ghp_secret');
  });

  it('errors on a missing value', () => {
    const r = parseArgs(['karpathy/nanochat', '--token']);
    expect(r.mode).toBe('error');
  });
});

describe('parseArgs — config subcommand', () => {
  it('parses `config get` with no key', () => {
    expect(parseArgs(['config', 'get'])).toEqual({
      mode: 'config',
      op: 'get',
    });
  });

  it('parses `config get <key>`', () => {
    expect(parseArgs(['config', 'get', 'format'])).toEqual({
      mode: 'config',
      op: 'get',
      key: 'format',
    });
  });

  it('parses `config set <key> <value>`', () => {
    expect(parseArgs(['config', 'set', 'format', 'json'])).toEqual({
      mode: 'config',
      op: 'set',
      key: 'format',
      value: 'json',
    });
  });

  it('parses `config list`', () => {
    expect(parseArgs(['config', 'list'])).toEqual({
      mode: 'config',
      op: 'list',
    });
  });

  it('errors when `config` has no operation', () => {
    const r = parseArgs(['config']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/config/);
  });

  it('errors on an unknown operation', () => {
    const r = parseArgs(['config', 'reset']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/get\|set\|list/);
  });

  it('errors when `config set` is missing the value', () => {
    const r = parseArgs(['config', 'set', 'format']);
    expect(r.mode).toBe('error');
  });

  it('errors when `config set` is missing key and value', () => {
    const r = parseArgs(['config', 'set']);
    expect(r.mode).toBe('error');
  });

  it('errors on extra arguments after `config get <key>`', () => {
    const r = parseArgs(['config', 'get', 'format', 'extra']);
    expect(r.mode).toBe('error');
  });

  it('errors on extra arguments after `config list`', () => {
    const r = parseArgs(['config', 'list', 'extra']);
    expect(r.mode).toBe('error');
  });
});

describe('parseArgs — error edges', () => {
  it('errors on an unknown flag', () => {
    const r = parseArgs(['karpathy/nanochat', '--bogus']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--bogus/);
  });

  it('errors on a second positional <org>/<repo>', () => {
    const r = parseArgs(['karpathy/nanochat', 'foo/bar']);
    expect(r.mode).toBe('error');
  });

  it('errors when a flag value looks like another flag', () => {
    const r = parseArgs(['karpathy/nanochat', '--since', '--max-age', '30d']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/--since/);
  });

  it('errors when a non-repo positional is given', () => {
    const r = parseArgs(['notarepo']);
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.message).toMatch(/<org>\/<repo>/);
  });

  it('accepts flags before the repo positional', () => {
    const opts = analyzeOptions(parseArgs(['--since', '2026-01-01', 'karpathy/nanochat']));
    expect(opts.since).toEqual(new Date('2026-01-01T00:00:00Z'));
  });
});

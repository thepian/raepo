import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnalyze } from '../../src/analyze.ts';
import type { CollectResult } from '../../src/collect.ts';
import type { AnalyzeArgs } from '../../src/command.ts';
import { BUILT_IN_DEFAULTS, writeConfig } from '../../src/config.ts';
import { ProviderHttpError, ProviderRateLimitError } from '../../src/provider/types.ts';

vi.mock('../../src/collect', () => ({ collect: vi.fn() }));
vi.mock('../../src/auth', () => ({ resolveToken: vi.fn().mockResolvedValue(null) }));
vi.mock('../../src/provider', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), createProvider: vi.fn().mockReturnValue({}) };
});

const REPO = { org: 'acme', name: 'app' };

function makeArgs(overrides: Partial<AnalyzeArgs['options']> = {}): AnalyzeArgs {
  return {
    mode: 'analyze',
    repo: REPO,
    options: { authors: [], verbose: false, ...overrides },
    config: BUILT_IN_DEFAULTS,
  };
}

// --- Builder tests ---

describe('buildAnalyze — state construction', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raepo-az-'));
    configPath = join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns error command when config file is malformed', async () => {
    writeFileSync(configPath, 'not json');
    const cmd = buildAnalyze(makeArgs(), configPath);
    expect(cmd.mode).toBe('error');
    expect(await cmd.run()).toBe(1);
  });

  it('applies built-in defaults when no config file and no CLI flags', () => {
    const cmd = buildAnalyze(makeArgs(), configPath);
    expect(cmd).toMatchObject({
      mode: 'analyze',
      repo: REPO,
      format: BUILT_IN_DEFAULTS.format,
      sort: BUILT_IN_DEFAULTS.sort,
      includeBots: BUILT_IN_DEFAULTS.includeBots,
    });
  });

  it('config file values override built-in defaults', () => {
    writeConfig({ format: 'json', sort: 'tail' }, configPath);
    const cmd = buildAnalyze(makeArgs(), configPath);
    expect(cmd).toMatchObject({ format: 'json', sort: 'tail' });
  });

  it('CLI format flag overrides config file', () => {
    writeConfig({ format: 'csv' }, configPath);
    const cmd = buildAnalyze(makeArgs({ format: 'json' }), configPath);
    expect(cmd).toMatchObject({ format: 'json' });
  });

  it('CLI sort flag overrides config file', () => {
    writeConfig({ sort: 'tail' }, configPath);
    const cmd = buildAnalyze(makeArgs({ sort: 'average' }), configPath);
    expect(cmd).toMatchObject({ sort: 'average' });
  });

  it('CLI includeBots flag overrides config file', () => {
    writeConfig({ includeBots: false }, configPath);
    const cmd = buildAnalyze(makeArgs({ includeBots: true }), configPath);
    expect(cmd).toMatchObject({ includeBots: true });
  });

  it('passes through authors, verbose, since, limit, token', () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const cmd = buildAnalyze(
      makeArgs({ authors: ['alice', 'bob'], verbose: true, since, limit: 10, token: 'tok' }),
      configPath,
    );
    expect(cmd).toMatchObject({
      authors: ['alice', 'bob'],
      verbose: true,
      since,
      limit: 10,
      token: 'tok',
    });
  });
});

// --- Runner tests ---

describe('buildAnalyze — run()', () => {
  let dir: string;
  let configPath: string;
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raepo-azr-'));
    configPath = join(dir, 'config.json');
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
    vi.clearAllMocks();
  });

  async function mockCollect() {
    const { collect } = await import('../../src/collect.ts');
    return collect as ReturnType<typeof vi.fn>;
  }

  const emptyResult: CollectResult = { prs: [], fetched: 0, filtered: 0, botsExcluded: 0 };

  it('exits 2 and prints rate-limit hint on ProviderRateLimitError', async () => {
    const collect = await mockCollect();
    collect.mockRejectedValue(
      new ProviderRateLimitError('rate limit', new Date('2024-06-01T12:00:00Z')),
    );

    const code = await buildAnalyze(makeArgs(), configPath).run();
    expect(code).toBe(2);
    expect(stderr).toMatch(/rate limit/);
    expect(stderr).toMatch(/GITHUB_TOKEN|gh auth/);
  });

  it('exits 2 and prints org/name prefix on ProviderHttpError', async () => {
    const collect = await mockCollect();
    collect.mockRejectedValue(new ProviderHttpError('Not Found', 404));

    const code = await buildAnalyze(makeArgs(), configPath).run();
    expect(code).toBe(2);
    expect(stderr).toMatch(/acme\/app/);
    expect(stderr).toMatch(/Not Found/);
  });

  it('exits 2 and prints org/name prefix on generic error', async () => {
    const collect = await mockCollect();
    collect.mockRejectedValue(new Error('network timeout'));

    const code = await buildAnalyze(makeArgs(), configPath).run();
    expect(code).toBe(2);
    expect(stderr).toMatch(/acme\/app/);
    expect(stderr).toMatch(/network timeout/);
  });

  it('exits 0 and writes JSON output when PRs are found', async () => {
    const collect = await mockCollect();
    collect.mockResolvedValue(emptyResult);

    const code = await buildAnalyze(makeArgs({ format: 'json' }), configPath).run();
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('exits 0 and reports "no PRs found" when author filter matches nothing', async () => {
    const collect = await mockCollect();
    collect.mockResolvedValue({ ...emptyResult, fetched: 5 });

    const code = await buildAnalyze(
      makeArgs({ authors: ['alice'], format: 'plain' }),
      configPath,
    ).run();
    expect(code).toBe(0);
    expect(stderr).toMatch(/no PRs found.*alice/);
  });
});

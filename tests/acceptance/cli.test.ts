import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const cli = resolve(repoRoot, 'src/cli.ts');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

function runCli(...args: string[]) {
  return spawnSync('bun', ['run', cli, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
}

function runCliWith(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('bun', ['run', cli, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
}

describe('raepo CLI', () => {
  it('prints the package version with --version', () => {
    const r = runCli('--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
    expect(r.stderr).toBe('');
  });

  it('prints help with --help', () => {
    const r = runCli('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage/);
    expect(r.stdout).toMatch(/--since/);
    expect(r.stdout).toMatch(/--author/);
  });

  it('prints help when called with no arguments', () => {
    const r = runCli();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage/);
  });

  it('reports parser errors on stderr with a help hint', () => {
    const r = runCli('karpathy/nanochat', '--bogus');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--bogus/);
    expect(r.stderr).toMatch(/raepo --help/);
  });

  it('reports an invalid org/repo with a clear message', () => {
    const r = runCli('notarepo');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/<org>\/<repo>/);
  });
});

describe('raepo CLI — config subcommand', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(`${tmpdir()}/raepo-acceptance-`);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('set, then get, then list reads back the value with source=config', () => {
    const set = runCliWith({ HOME: home }, 'config', 'set', 'format', 'json');
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('format=json');

    const get = runCliWith({ HOME: home }, 'config', 'get', 'format');
    expect(get.status).toBe(0);
    expect(get.stdout.trim()).toBe('json');

    const list = runCliWith({ HOME: home }, 'config', 'list');
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/format\s+json\s+config/);
    expect(list.stdout).toMatch(/sort\s+merged\s+default/);
  });

  it('env var takes precedence over the config file in `config list`', () => {
    runCliWith({ HOME: home }, 'config', 'set', 'sort', 'typical');
    const list = runCliWith({ HOME: home, RAEPO_SORT: 'tail' }, 'config', 'list');
    expect(list.stdout).toMatch(/sort\s+tail\s+env/);
  });

  it('rejects an unknown key on set with exit code 1', () => {
    const r = runCliWith({ HOME: home }, 'config', 'set', 'bogus', 'value');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bogus/);
  });

  it('rejects an invalid value on set with exit code 1', () => {
    const r = runCliWith({ HOME: home }, 'config', 'set', 'sort', 'name');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sort/);
  });
});

describe.skipIf(process.env.RAEPO_SKIP_LIVE === '1')('raepo CLI — live (end-to-end)', () => {
  it('produces a table for karpathy/nanochat', () => {
    const r = runCli('karpathy/nanochat', '--max-age', '90d');
    expect(r.status, `stderr was: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Repo:');
    expect(r.stdout).toContain('karpathy/nanochat');
    expect(r.stdout).toContain('PRs:');
    expect(r.stdout).toContain('Author');
    expect(r.stdout).toContain('typical');
    expect(r.stdout).toContain('average');
    expect(r.stdout).toContain('tail');
    expect(r.stdout).toContain('accept');
  }, 30000);

  it('produces parseable JSON with --format json', () => {
    const r = runCli('karpathy/nanochat', '--max-age', '90d', '--format', 'json');
    expect(r.status, `stderr was: ${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      version: number;
      repo: { org: string; name: string };
      authors: unknown[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.repo).toEqual({ org: 'karpathy', name: 'nanochat' });
    expect(Array.isArray(parsed.authors)).toBe(true);
  }, 30000);

  it('returns a clear error and non-zero exit for a non-existent repo', () => {
    const r = runCli('karpathy/this-repo-does-not-exist-xyz-9999');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/karpathy\/this-repo-does-not-exist-xyz-9999/);
    expect(r.stderr).toMatch(/404/);
  }, 30000);

  // The --author filter routes to GitHub's Search API. Multiple `author:`
  // qualifiers space-separated are OR-combined (verified live: 20+3 closed
  // PRs for svlandeg+francip individually = 23 combined). This test guards
  // against regression if GitHub ever changes that semantic.
  it('multi-author filter returns the union of both authors and nothing else', () => {
    const r = runCli('karpathy/nanochat', '--author', 'svlandeg,francip', '--format', 'json');
    expect(r.status, `stderr was: ${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as { authors: Array<{ login: string }> };
    const logins = parsed.authors.map((a) => a.login).sort();
    expect(logins).toEqual(['francip', 'svlandeg']);
  }, 30000);
});

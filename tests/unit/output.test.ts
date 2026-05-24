import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatPercent,
  type OutputContext,
  render,
  renderAuthorDetail,
  renderCsv,
  renderJson,
  renderTable,
  sortStats,
  wrapList,
} from '../../src/output.ts';
import type { AuthorStats } from '../../src/stats.ts';
import { DAY_MS as DAY, HOUR_MS as HOUR, MINUTE_MS as MIN } from '../../src/time.ts';

const CTX: OutputContext = {
  repo: { org: 'karpathy', name: 'nanochat' },
  since: new Date('2026-01-01T00:00:00Z'),
  generatedAt: new Date('2026-05-03T00:00:00Z'),
  summary: { totalAnalyzed: 142, merged: 118, closedUnmerged: 24, authors: 18 },
  includeBots: false,
  botsExcluded: 31,
};

function stats(overrides: Partial<AuthorStats> = {}): AuthorStats {
  return {
    login: 'alice',
    merged: 42,
    closedUnmerged: 1,
    typical: 1.2 * DAY,
    average: 2.4 * DAY,
    tail: 8.1 * DAY,
    accept: 0.98,
    ...overrides,
  };
}

describe('formatDuration', () => {
  it.each([
    [null, '—'],
    [1.2 * DAY, '1.2d'],
    [2.4 * DAY, '2.4d'],
    [12.0 * DAY, '12.0d'],
    [3.5 * HOUR, '3.5h'],
    [55 * MIN, '55.0m'],
    [30 * 1000, '<1m'],
    [0, '<1m'],
  ])('formats %sms as "%s"', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatPercent', () => {
  it.each([
    [null, '—'],
    [1, '100%'],
    [0.98, '98%'],
    [0.5, '50%'],
    [0, '0%'],
  ])('formats %s as "%s"', (n, expected) => {
    expect(formatPercent(n)).toBe(expected);
  });
});

describe('sortStats', () => {
  const a = stats({ login: 'a', merged: 10, typical: 1 * DAY, accept: 0.9 });
  const b = stats({ login: 'b', merged: 30, typical: 5 * DAY, accept: 0.5 });
  const c = stats({ login: 'c', merged: 20, typical: null, accept: null });

  it('sorts by merged desc by default', () => {
    expect(sortStats([a, b, c], 'merged').map((s) => s.login)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by typical asc (faster merge time first), nulls last', () => {
    expect(sortStats([a, b, c], 'typical').map((s) => s.login)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by accept desc, nulls last', () => {
    expect(sortStats([a, b, c], 'accept').map((s) => s.login)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by tail asc (fastest tail first)', () => {
    const x = stats({ login: 'x', tail: 10 * DAY });
    const y = stats({ login: 'y', tail: 2 * DAY });
    const z = stats({ login: 'z', tail: null });
    expect(sortStats([x, y, z], 'tail').map((s) => s.login)).toEqual(['y', 'x', 'z']);
  });
});

describe('renderJson', () => {
  it('emits a parseable, versioned schema', () => {
    const out = renderJson([stats()], CTX);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.repo).toEqual({ org: 'karpathy', name: 'nanochat' });
    expect(parsed.summary).toEqual(CTX.summary);
    expect(parsed.options).toMatchObject({ includeBots: false, botsExcluded: 31 });
    expect(Array.isArray(parsed.authors)).toBe(true);
  });

  it('preserves raw ms values in the authors array (no formatting)', () => {
    const out = renderJson([stats({ typical: 1.2 * DAY })], CTX);
    const parsed = JSON.parse(out) as { authors: Array<{ typical: number }> };
    expect(parsed.authors[0]?.typical).toBe(1.2 * DAY);
  });

  it('emits ISO date strings, not Date objects', () => {
    const out = renderJson([stats()], CTX);
    const parsed = JSON.parse(out) as { window: { since: string | null } };
    expect(parsed.window.since).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('renderCsv', () => {
  it('includes a header row and one data row per author', () => {
    const out = renderCsv([stats({ login: 'alice' }), stats({ login: 'bob' })], CTX);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('login,merged,closed_unmerged,typical_ms,average_ms,tail_ms,accept');
    expect(lines[1]).toContain('alice');
    expect(lines[2]).toContain('bob');
  });

  it('escapes login containing a comma', () => {
    const out = renderCsv([stats({ login: 'odd,name' })], CTX);
    expect(out).toContain('"odd,name"');
  });

  it('emits empty string for null numeric fields', () => {
    const out = renderCsv([stats({ typical: null, average: null, tail: null, accept: null })], CTX);
    const dataLine = out.trim().split('\n')[1] ?? '';
    expect(dataLine.split(',').slice(3)).toEqual(['', '', '', '']);
  });
});

describe('renderTable', () => {
  it('shows the repo, window, and summary header', () => {
    const out = renderTable([stats()], CTX);
    expect(out).toContain('Repo:');
    expect(out).toContain('karpathy/nanochat');
    expect(out).toContain('Window:');
    expect(out).toContain('2026-01-01');
    expect(out).toContain('142 analyzed');
    expect(out).toContain('118 merged');
    expect(out).toContain('24 closed-unmerged');
    expect(out).toContain('31 bots excluded');
  });

  it('renders a column header and a row per author', () => {
    const out = renderTable([stats({ login: 'alice' }), stats({ login: 'bob' })], CTX);
    expect(out).toContain('Author');
    expect(out).toContain('merged');
    expect(out).toContain('typical');
    expect(out).toContain('alice');
    expect(out).toContain('bob');
  });

  it('renders "—" for null numeric cells', () => {
    const out = renderTable([stats({ login: 'mystery', typical: null, accept: null })], CTX);
    expect(out).toContain('mystery');
    expect(out).toContain('—');
  });

  it('handles an empty stats array (no authors found)', () => {
    const out = renderTable([], CTX);
    expect(out).toContain('No PRs matched');
  });

  it('omits "bots excluded" when includeBots is true', () => {
    const out = renderTable([stats()], { ...CTX, includeBots: true, botsExcluded: 0 });
    expect(out).not.toContain('bots excluded');
  });
});

describe('renderTable — author partitioning', () => {
  function noMergeStats(login: string): AuthorStats {
    return {
      login,
      merged: 0,
      closedUnmerged: 1,
      typical: null,
      average: null,
      tail: null,
      accept: 0,
    };
  }

  function allMergedStats(login: string): AuthorStats {
    return {
      login,
      merged: 1,
      closedUnmerged: 0,
      typical: 1 * DAY,
      average: 1 * DAY,
      tail: 1 * DAY,
      accept: 1,
    };
  }

  it('keeps authors with merged > 0 in the main table regardless of closedUnmerged', () => {
    const out = renderTable([stats({ login: 'mixed' }), allMergedStats('always')], CTX);
    expect(out).toContain('Author');
    expect(out).toContain('mixed');
    expect(out).toContain('always');
    expect(out).not.toContain('No accepted PRs');
  });

  it('demotes authors with merged === 0 to a "No accepted" line', () => {
    const out = renderTable(
      [stats({ login: 'mixed' }), noMergeStats('never-1'), noMergeStats('never-2')],
      CTX,
    );
    expect(out).toContain('No accepted PRs (2):');
    expect(out).toContain('never-1');
    expect(out).toContain('never-2');
    // and the main table still has the merged>0 author
    expect(out).toContain('mixed');
  });

  it('renders only the "No accepted" line (no table) when every author has merged === 0', () => {
    const out = renderTable([noMergeStats('a'), noMergeStats('b')], CTX);
    expect(out).not.toContain('Author');
    expect(out).toContain('No accepted PRs (2):');
  });

  it('with partition: false, includes merged===0 authors in the table (no "No accepted" line)', () => {
    const out = renderTable(
      [stats({ login: 'mixed' }), noMergeStats('never-1'), noMergeStats('never-2')],
      CTX,
      { partition: false },
    );
    expect(out).toContain('Author');
    expect(out).toContain('mixed');
    expect(out).toContain('never-1');
    expect(out).toContain('never-2');
    expect(out).not.toContain('No accepted PRs');
  });

  it('wraps the "No accepted" list at 60 chars', () => {
    const longSet = Array.from({ length: 25 }, (_, i) =>
      noMergeStats(`author-${String(i).padStart(2, '0')}`),
    );
    const out = renderTable(longSet, CTX);
    const listLines = out.split('\n').filter((l) => /^\s+author-/.test(l));
    expect(listLines.length).toBeGreaterThan(1);
    for (const line of listLines) {
      expect(line.length, `line too long: "${line}"`).toBeLessThanOrEqual(60);
    }
  });
});

describe('renderAuthorDetail', () => {
  it('renders a vertical label:value layout for one author', () => {
    const out = renderAuthorDetail(
      {
        login: 'alice',
        merged: 12,
        closedUnmerged: 3,
        typical: 1.2 * DAY,
        average: 2.4 * DAY,
        tail: 8.1 * DAY,
        accept: 0.8,
      },
      CTX,
    );
    expect(out).toContain('Author:');
    expect(out).toContain('alice');
    expect(out).toContain('Repo:');
    expect(out).toContain('karpathy/nanochat');
    expect(out).toContain('Window:');
    expect(out).toContain('Merged:');
    expect(out).toContain('12');
    expect(out).toContain('Closed unmerged:');
    expect(out).toContain('Typical:');
    expect(out).toContain('1.2d');
    expect(out).toContain('Average:');
    expect(out).toContain('Tail (p90):');
    expect(out).toContain('Acceptance:');
    expect(out).toContain('80%');
    // not a table
    expect(out).not.toContain('───');
  });

  it('renders "—" for null time stats (author with no merges)', () => {
    const out = renderAuthorDetail(
      {
        login: 'mystery',
        merged: 0,
        closedUnmerged: 5,
        typical: null,
        average: null,
        tail: null,
        accept: 0,
      },
      CTX,
    );
    expect(out).toContain('mystery');
    expect(out).toContain('—');
    expect(out).toContain('0%');
  });
});

describe('render — view selection', () => {
  function noMergeStats(login: string): AuthorStats {
    return {
      login,
      merged: 0,
      closedUnmerged: 1,
      typical: null,
      average: null,
      tail: null,
      accept: 0,
    };
  }

  it('1 author + format=table → detail view', () => {
    const result = render([stats({ login: 'alice' })], CTX, {
      format: 'plain',
      authors: ['alice'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('Author:');
    expect(result.output).toContain('alice');
    expect(result.output).not.toContain('───');
  });

  it('1 author + format=table + author not in stats → no-such-author result', () => {
    const result = render([stats({ login: 'alice' })], CTX, {
      format: 'plain',
      authors: ['ghost'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-such-author');
    expect(result.author).toBe('ghost');
  });

  it('2+ authors + format=table → table without partition (merged===0 still in table)', () => {
    const result = render([stats({ login: 'alice' }), noMergeStats('never')], CTX, {
      format: 'plain',
      authors: ['alice', 'never'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('Author');
    expect(result.output).toContain('alice');
    expect(result.output).toContain('never');
    expect(result.output).not.toContain('No accepted PRs');
  });

  it('0 authors + format=table → table with partition', () => {
    const result = render([stats({ login: 'alice' }), noMergeStats('never')], CTX, {
      format: 'plain',
      authors: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('alice');
    expect(result.output).toContain('No accepted PRs');
    expect(result.output).toContain('never');
  });

  it('format=json + 1 author → structured JSON (not detail view)', () => {
    const result = render([stats({ login: 'alice' })], CTX, {
      format: 'json',
      authors: ['alice'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output) as { version: number; authors: unknown[] };
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.authors)).toBe(true);
  });

  it('format=csv + 1 author → CSV (not detail view)', () => {
    const result = render([stats({ login: 'alice' })], CTX, {
      format: 'csv',
      authors: ['alice'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('login,merged');
    expect(result.output).toContain('alice');
  });

  it('limit truncates the table view', () => {
    const set = Array.from({ length: 5 }, (_, i) => stats({ login: `a${i}` }));
    const result = render(set, CTX, { format: 'plain', authors: [], limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('a0');
    expect(result.output).toContain('a1');
    expect(result.output).not.toContain('a2');
  });
});

describe('wrapList', () => {
  it('returns empty array for empty input', () => {
    expect(wrapList([], 40)).toEqual([]);
  });

  it('fits short lists on one line', () => {
    expect(wrapList(['a', 'b', 'c'], 60)).toEqual(['a, b, c']);
  });

  it('wraps when total exceeds maxWidth', () => {
    const result = wrapList(['alice', 'bob', 'carol', 'dan'], 16);
    expect(result.length).toBeGreaterThan(1);
    for (const line of result) expect(line.length).toBeLessThanOrEqual(16);
  });

  it('applies indent to every line', () => {
    const result = wrapList(['alice', 'bob', 'carol', 'dan'], 18, '> ');
    for (const line of result) expect(line.startsWith('> ')).toBe(true);
  });

  it('keeps a single oversized item on its own line rather than truncating', () => {
    const result = wrapList(['short', 'thisnameislongerthanthemaxwidth'], 10);
    expect(result).toContain('thisnameislongerthanthemaxwidth');
  });
});

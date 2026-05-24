import { bold, cyan, dim, green, red, yellow } from 'picocolors';
import type { Format, Repo, SortKey } from './command.ts';
import type { AuthorStats, RepoSummary } from './stats.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.ts';

function paintAccept(ratio: number | null, text: string): string {
  if (ratio === null) return text;
  if (ratio >= 0.8) return green(text);
  if (ratio >= 0.5) return yellow(text);
  return red(text);
}

function boldCyan(s: string): string {
  return bold(cyan(s));
}

export type OutputContext = {
  repo: Repo;
  since?: Date;
  generatedAt: Date;
  summary: RepoSummary;
  includeBots: boolean;
  botsExcluded: number;
};

const NA = '—';

/** Wrap width for the simple author-list lines (logins + commas). */
const LIST_WRAP = 60;
const LIST_INDENT = '  ';

export function formatDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return NA;
  if (ms >= DAY_MS) return `${(ms / DAY_MS).toFixed(1)}d`;
  if (ms >= HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)}h`;
  if (ms >= MINUTE_MS) return `${(ms / MINUTE_MS).toFixed(1)}m`;
  return '<1m';
}

export function formatPercent(p: number | null): string {
  if (p === null) return NA;
  return `${Math.round(p * 100)}%`;
}

/**
 * Sort policy:
 *   - `merged`, `accept`: descending (more is better)
 *   - `typical`, `average`, `tail`: ascending (less is better)
 *   - Nulls sort to the end in every case (no merged PRs → no time stat → bottom)
 */
export function sortStats(stats: AuthorStats[], key: SortKey): AuthorStats[] {
  const ascending = key === 'typical' || key === 'average' || key === 'tail';
  return [...stats].sort((a, b) => compareNullable(a[key], b[key], ascending));
}

function compareNullable(a: number | null, b: number | null, ascending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return ascending ? a - b : b - a;
}

export function renderJson(stats: AuthorStats[], ctx: OutputContext): string {
  return `${JSON.stringify(
    {
      version: 1,
      repo: ctx.repo,
      window: { since: ctx.since?.toISOString() ?? null },
      generatedAt: ctx.generatedAt.toISOString(),
      summary: ctx.summary,
      options: {
        includeBots: ctx.includeBots,
        botsExcluded: ctx.botsExcluded,
      },
      authors: stats,
    },
    null,
    2,
  )}\n`;
}

const CSV_HEADER = 'login,merged,closed_unmerged,typical_ms,average_ms,tail_ms,accept';

export function renderCsv(stats: AuthorStats[], _ctx: OutputContext): string {
  const lines = [CSV_HEADER];
  for (const s of stats) {
    lines.push(
      [
        csvField(s.login),
        s.merged,
        s.closedUnmerged,
        s.typical ?? '',
        s.average ?? '',
        s.tail ?? '',
        s.accept ?? '',
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export type RenderTableOptions = {
  /**
   * When true (default), authors with `merged === 0` are pulled out of the
   * table into a compact "No accepted PRs" line. When false (e.g. when the
   * caller has already filtered to a specific author allowlist), every author
   * stays in the table — no surprise removals.
   */
  partition?: boolean;
};

export function renderTable(
  stats: AuthorStats[],
  ctx: OutputContext,
  opts: RenderTableOptions = {},
): string {
  const partition = opts.partition ?? true;
  const lines: string[] = [];
  lines.push(`${dim('Repo:   ')} ${cyan(`${ctx.repo.org}/${ctx.repo.name}`)}`);
  lines.push(`${dim('Window: ')} ${formatWindow(ctx)}`);
  lines.push(`${dim('PRs:    ')} ${formatSummaryLine(ctx)}`);
  lines.push('');

  if (stats.length === 0) {
    lines.push('No PRs matched the filters.');
    return `${lines.join('\n')}\n`;
  }

  // Partition (default): authors with merged > 0 stay in the table; authors
  // with merged === 0 get demoted. When we eventually fetch open PRs, the
  // merged===0 group will split further into "No accepted" (had
  // closed-unmerged) vs "No closed" (only open).
  const main = partition ? stats.filter((s) => s.merged > 0) : stats;
  const noAccepted = partition ? stats.filter((s) => s.merged === 0 && s.closedUnmerged > 0) : [];

  if (main.length > 0) {
    appendTable(lines, main);
  }

  appendAuthorLine(lines, 'No accepted PRs', noAccepted);

  /*
  if (main.length > 0) {
    lines.push('');
    lines.push('  typical  median time from PR open to merge');
    lines.push('  average  mean time from PR open to merge');
    lines.push('  tail     90th percentile (slowest 10%)');
    lines.push('  accept   merged / (merged + closed-unmerged)');
  }
  */

  return `${lines.join('\n')}\n`;
}

export type RenderInput = {
  format: Format;
  /** The user's --author allowlist. Length determines view selection. */
  authors: string[];
  /** Optional cap on the number of rows in the table view (no effect on detail/json/csv-with-1-author). */
  limit?: number;
};

export type RenderResult =
  | { ok: true; output: string }
  | { ok: false; reason: 'no-such-author'; author: string };

/**
 * Single entry point for rendering. Owns the policy of which view fits which
 * input shape. The CLI calls this once and writes the result; it doesn't need
 * to know about the table/detail/partition split.
 *
 * Selection rules:
 *   - format=table + authors.length === 1 → vertical detail view (label:value)
 *   - format=table + authors.length === 0 → table with partition (merged===0
 *       authors get demoted to a "No accepted PRs" line)
 *   - format=table + authors.length >= 2 → table without partition (the user
 *       picked the authors; don't surprise-hide any)
 *   - format=json or format=csv → structured shape regardless of author count
 */
export function render(stats: AuthorStats[], ctx: OutputContext, input: RenderInput): RenderResult {
  if (input.format === 'plain' && input.authors.length === 1) {
    const target = input.authors[0] as string;
    const single = stats.find((s) => s.login === target);
    if (!single) return { ok: false, reason: 'no-such-author', author: target };
    return { ok: true, output: renderAuthorDetail(single, ctx) };
  }

  const limited = input.limit ? stats.slice(0, input.limit) : stats;

  switch (input.format) {
    case 'json':
      return { ok: true, output: renderJson(limited, ctx) };
    case 'csv':
      return { ok: true, output: renderCsv(limited, ctx) };
    case 'plain':
      return {
        ok: true,
        output: renderTable(limited, ctx, { partition: input.authors.length === 0 }),
      };
  }
}

/**
 * Detail view for a single author: a vertical label:value layout. Triggered
 * by `render()` when the user has scoped to exactly one author and wants the
 * default `table` output format.
 */
export function renderAuthorDetail(stats: AuthorStats, ctx: OutputContext): string {
  const lines: string[] = [];
  const label = (k: string, v: string) => `${dim(k.padEnd(18))} ${v}`;

  lines.push(label('Author:', boldCyan(stats.login)));
  lines.push(label('Repo:', cyan(`${ctx.repo.org}/${ctx.repo.name}`)));
  lines.push(label('Window:', formatWindow(ctx)));
  lines.push('');
  lines.push(label('Merged:', String(stats.merged)));
  lines.push(label('Closed unmerged:', String(stats.closedUnmerged)));
  lines.push(label('Typical:', formatDuration(stats.typical)));
  lines.push(label('Average:', formatDuration(stats.average)));
  lines.push(label('Tail (p90):', formatDuration(stats.tail)));
  lines.push(label('Acceptance:', paintAccept(stats.accept, formatPercent(stats.accept))));

  return `${lines.join('\n')}\n`;
}

function appendTable(lines: string[], stats: AuthorStats[]): void {
  const headers = ['Author', 'merged', 'typical', 'average', 'tail', 'accept'];
  const ACCEPT_COL = 5;
  const rows: string[][] = stats.map((s) => [
    s.login,
    String(s.merged),
    formatDuration(s.typical),
    formatDuration(s.average),
    formatDuration(s.tail),
    formatPercent(s.accept),
  ]);

  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const row of rows) w = Math.max(w, (row[i] ?? '').length);
    return w;
  });

  // Pad first (using unstyled length), then paint — ANSI codes have zero
  // visual width, so columns stay aligned.
  const padCell = (cell: string, i: number): string => {
    const w = widths[i] ?? cell.length;
    return i === 0 ? cell.padEnd(w) : cell.padStart(w);
  };

  lines.push(headers.map((h, i) => bold(padCell(h, i))).join('  '));
  const ruleLength = widths.reduce((sum, w) => sum + w, 0) + (widths.length - 1) * 2;
  lines.push(dim('─'.repeat(ruleLength)));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as string[];
    const accept = stats[r]?.accept ?? null;
    lines.push(
      row
        .map((cell, i) => {
          const padded = padCell(cell, i);
          if (i === ACCEPT_COL) return paintAccept(accept, padded);
          return padded;
        })
        .join('  '),
    );
  }
}

function appendAuthorLine(lines: string[], label: string, group: AuthorStats[]): void {
  if (group.length === 0) return;
  lines.push('');
  lines.push(yellow(`${label} (${group.length}):`));
  for (const line of wrapList(
    group.map((s) => s.login),
    LIST_WRAP,
    LIST_INDENT,
  )) {
    lines.push(dim(line));
  }
}

/**
 * Wrap a list of strings into comma-separated lines no wider than `maxWidth`,
 * each prefixed by `indent`. Single items longer than `maxWidth` are kept
 * on their own line rather than being broken mid-word.
 */
export function wrapList(items: string[], maxWidth: number, indent = ''): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  let current = indent;
  for (let i = 0; i < items.length; i++) {
    const piece = `${items[i]}${i < items.length - 1 ? ',' : ''}`;
    if (current === indent) {
      current = `${indent}${piece}`;
    } else if (current.length + 1 + piece.length <= maxWidth) {
      current = `${current} ${piece}`;
    } else {
      lines.push(current);
      current = `${indent}${piece}`;
    }
  }
  if (current !== indent) lines.push(current);
  return lines;
}

function formatWindow(ctx: OutputContext): string {
  const until = isoDate(ctx.generatedAt);
  if (!ctx.since) return `(all time) → ${until}`;
  return `${isoDate(ctx.since)} → ${until}`;
}

function isoDate(d: Date): string {
  return (d.toISOString().split('T')[0] as string) ?? '';
}

function formatSummaryLine(ctx: OutputContext): string {
  const { totalAnalyzed, merged, closedUnmerged } = ctx.summary;
  const parts = [`${merged} merged`, `${closedUnmerged} closed-unmerged`];
  if (!ctx.includeBots && ctx.botsExcluded > 0) {
    parts.push(`${ctx.botsExcluded} bots excluded`);
  }
  return `${totalAnalyzed} analyzed (${parts.join(', ')})`;
}

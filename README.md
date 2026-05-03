# raepo

A command-line tool for understanding how long pull requests take to merge in
a GitHub repository — broken down by author, with honest statistics.

```
$ raepo karpathy/nanochat --since 2026-01-01

Repo:    karpathy/nanochat
Window:  2026-01-01 → 2026-05-03
PRs:     142 analyzed (118 merged, 24 closed-unmerged, 31 bots excluded)

Author          merged  typical   average     tail   accept
────────────────────────────────────────────────────────────
alice               42    1.2d      2.4d     8.1d      98%
bob                 31    0.8d      1.1d     3.2d      94%
carol               18    3.4d      5.6d    18.0d      82%
dan                 11    0.5d      0.7d     2.1d     100%
…

  typical  median time from PR open to merge
  average  mean time from PR open to merge
  tail     90th percentile (slowest 10%)
  accept   merged / (merged + closed-unmerged)
```

## Install

| Tool                  | Command                       |
| --------------------- | ----------------------------- |
| One-off (no install)  | `npx raepo …` / `bunx raepo …` |
| Global (npm)          | `npm i -g raepo`              |
| Global (bun)          | `bun add -g raepo`            |

After install, both `raepo` and `ræpo` resolve to the same binary. (npm package
names are ASCII-only, so the published package is `raepo`; `ræpo` is wired up
via the `bin` field for shell use.)

## Auth

raepo uses the GitHub REST API. Public repos work without a token but are
rate-limited (60 req/hour). Resolution order:

1. `--token <pat>`
2. `$GITHUB_TOKEN`
3. `gh auth token` (if the [`gh`](https://cli.github.com/) CLI is installed and authenticated)

Anything readable through your token is queryable, including private repos.

## Usage

```
raepo <org>/<repo> [options]
raepo config <get|set|list> [args]

Filters
  --since <date>          Only PRs created on or after <date> (YYYY-MM-DD)
  --max-age <duration>    Only PRs created within <duration> (e.g. 30d, 12w)
  --author <login>        Restrict to one author (repeatable)
  --include-bots          Include bot accounts (excluded by default)

Output
  --format <f>            table | json | csv  (default: table)
  --sort <key>            merged | typical | average | tail | accept
                          (default: merged, descending)
  --limit <n>             Show top n authors

Auth
  --token <pat>           GitHub personal access token
```

### Modes

- **Multi-author (default)** — table of authors, ranked.
- **Single author** — pass `--author alice` exactly once and raepo switches to
  a detail view: histogram of merge times and a list of recent PRs.

### JSON output

`--format json` emits a stable schema suitable for piping into `jq` or feeding
a dashboard. CSV is column-aligned with the table view.

### Defaults & config

raepo reads defaults from `~/.raepo/config.json`. Manage it with the
`config` subcommand:

```
raepo config set format json     # always emit JSON
raepo config set sort typical    # rank by median merge time
raepo config get format
raepo config list                # show all keys with their source (config | default)
```

Precedence is **CLI flag → environment variable → config file → built-in
default**. Tokens are best left to `$GITHUB_TOKEN` or `gh auth token` rather
than written to disk.

## What the numbers mean (and don't)

Per-author merge time is a function of the **whole system** — reviewer
availability, CI flakiness, PR size, time zones — not just author behaviour.
Read this tool as descriptive, not evaluative. Use it to spot bottlenecks
(long tails, low acceptance), not to rank people.

Bots (`dependabot`, `renovate`, `*[bot]`, anything with `user.type === "Bot"`)
are excluded by default because they skew everything; opt in with
`--include-bots`.

## Development

Built with **Bun + TypeScript**.

```
bun install
bun test
bun run build           # produces dist/raepo.js
bun run raepo …         # run from source
```

The published npm package ships the bundled JS so it runs on Node too.

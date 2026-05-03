```                                  
 _ __    ___ ___    _ __   ___  
| '__|  / _ ` _ \  | '_ \ / _ \ 
| |    | (_|  __/  | |_) | (_) |
|_|     \__,_\___| | .__/ \___/ 
                   |_|          
```

# raepo

A command-line tool for understanding how long pull requests take to merge in
a GitHub repository — broken down by author, with honest statistics.

```
$ raepo karpathy/nanochat --since 2026-01-01 --sort tail

fetched 154 PRs.
Repo:    karpathy/nanochat
Window:  2026-01-01 → 2026-05-04
PRs:     154 analyzed (28 merged, 126 closed-unmerged)

Author           merged  typical  average   tail  accept
────────────────────────────────────────────────────────
georgeshakan          1     2.4h     2.4h   2.4h    100%
Yamahammer            1     4.5h     4.5h   4.5h    100%
dipeshbabu            1     8.4h     8.4h   8.4h     33%
adriablancafort       1    21.7h    21.7h  21.7h    100%
...
svlandeg             11     1.4d     3.6d   5.9d     85%
aarushisingh04        1     7.2d     7.2d   7.2d    100%
marcinbogdanski       1    10.1d    10.1d  10.1d    100%
BlackSamorez          1    10.2d    10.2d  10.2d    100%
why2011btv            1    11.3d    11.3d  11.3d    100%
mathieu-lacage        1    12.4d    12.4d  12.4d    100%
2bitbit               1    13.5d    13.5d  13.5d    100%
ykirpichev            1    14.3d    14.3d  14.3d     50%
Jah-yee               1    15.9d    15.9d  15.9d     14%

No accepted PRs (81):
  aidev2o25, ACautomata, manmohan659, zolopgh, sranganath2,
  faitholopade-source, jake-molnia, giovannizinzi, hiSandog,
  dengdx, RohanKhanBD, hbfreed, JoseRodriguez26,
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


## Usage

```
raepo <org>/<repo> [options]
raepo config <get|set|list> [args]

Filters
  --since <date>          Only PRs created on or after <date> (YYYY-MM-DD)
  --max-age <duration>    Only PRs created within <duration> (e.g. 30d, 12w)
  --author <list>         Restrict to author(s); comma-separated, repeatable
  --include-bots          Include bot accounts (excluded by default)

Output
  --format <f>            plain | json | csv  (default: plain)
  --sort <key>            merged | typical | average | tail | accept
                          (default: merged, descending)
  --limit <n>             Show top n authors

Auth
  --token <pat>           GitHub personal access token to read private repos.

Other
  --verbose, -v           Print per-request rate-limit info to stderr
  --version, -V           Show version
```

To get a GitHub token you can run `gh auth token` (if the [`gh`](https://cli.github.com/) CLI is installed and authenticated)

### What the numbers mean (and don't)

Per-author merge time is a function of the **whole system** — reviewer
availability, CI flakiness, PR size, time zones — not just author behaviour.
Read this tool as descriptive, not evaluative. Use it to spot bottlenecks
(long tails, low acceptance), not to rank people.

Bots (`dependabot`, `renovate`, `*[bot]`, anything with `user.type === "Bot"`)
are excluded by default because they skew everything; opt in with
`--include-bots`.


## Features

What the tool does.

### Targets & access

Single repository per invocation: `raepo <org>/<repo>`. Public repos work
without auth (60 req/hour). If you supply a token, you can access private repositories
and get more requests to GitHub. On Unix you can pipe it in:

> bun run raepo karpathy/nanochat --since 2026-01-01 --token `gh auth token`

Since a token is so easy to generate, I didn't want the security concern of supporting
to save them with `raepo config`.


### Per-author statistics

Raepo reports five stats:

- `merged` — count of merged PRs
- `typical` — **median** time-to-merge (p50)
- `average` — mean time-to-merge
- `tail` — 90th percentile
- `accept` — merged / (merged + closed-unmerged)

> **Why median *and* mean:** PR merge times are heavily skewed — one
> 6-month-old PR can quintuple the mean. Median is the honest centre; the
> mean stays for people who explicitly ask for it. `tail` captures the
> long-tail behaviour the median hides; `accept` shows whether an author's
> PRs typically land at all. Together these read the *shape* of the
> distribution, not just one number from it.

> **Rejected (won't add later either):** per-author "review wait" /
> "author wait" responsiveness. The signal is too noisy at the per-PR
> level and the per-author cut reads as a performance metric. The honest
> "where do PRs get stuck?" view belongs in a repo-aggregate bottleneck
> view (see `PLAN.md`), not as an author column.

Bots are excluded by default and `merged === 0` authors get demoted to a
compact "No accepted PRs" line below the table — see [Modes](#modes) and
[What the numbers mean](#what-the-numbers-mean-and-dont) above.


### Only `authors` filter

The regular pull requests API doesn't support filtering by author, so since some
repos might have thousands, we use a different API to get to the PRs when you just
want the data for a few authors, so we can fetch data just for those.

- **Multiple `--author`** — `--author alice,bob` or `--author alice --author bob`.
  Table includes every specified author, no demotion. Server-side filtering via
  GitHub's search API, so we don't pull the whole repo.
- **Single `--author`** — shows vertical detail view (label:value) for that one
  author. Again using a serverside author query filter.

> **Why server-side filtering:** a 5,000-PR repo would otherwise burn the
> rate limit before producing one row. The endpoint switch is encapsulated
> inside the GitHub provider; the `Provider` interface stays clean for a
> future GitLab implementation.


### Filters

`max-age` and `since` filters are supported. We turn max-age into a since filter
before getting pages from the GitHub API, where we stop fetching once we get past
the since timestamp.


### Defaults & config

raepo reads defaults from `~/.raepo/config.json`. Manage it with the
`config` subcommand:

```
raepo config set format json     # always emit JSON
raepo config set sort typical    # rank by median merge time
raepo config get format
raepo config list                # show all keys with their source (env | config | default)
```

Schema keys (all optional): `format`, `sort`, `include-bots`, `concurrency`.
The matching env vars are `RAEPO_FORMAT`, `RAEPO_SORT`, `RAEPO_INCLUDE_BOTS`,
`RAEPO_CONCURRENCY`.

Precedence is **CLI flag → `RAEPO_*` env var → config file → built-in
default**. Tokens are deliberately not a config key — use `$GITHUB_TOKEN` or
`gh auth token` so they don't sit on disk.


### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Success (or zero matches for a queried author — that's not an error) |
| `1`  | User error: bad flag, malformed `<org>/<repo>`, invalid config key/value, malformed config file |
| `2`  | Network or GitHub error: rate limit, 401/404/5xx after retries exhausted |


### Beyond the brief

- **Three output formats** — `plain` (default), `json` (stable versioned
  schema), `csv`. JSON is shaped for `jq` or for feeding a dashboard.
- **View modes that adapt to author count** — zero authors = ranked table
  with demotions; one author = vertical label:value detail; two or more =
  table without demotion. All three formats stay available via `--format`.
- **`config` subcommand** — persisted defaults at `~/.raepo/config.json`
  with a versioned schema and `RAEPO_*` env-var overrides.
- **`--verbose` mode** — surfaces per-request `x-ratelimit-remaining` /
  `reset` to stderr; useful when planning a long run against a private
  repo.
- **provider** — GitHub API is implemented as provider so we can add support
  for GitLab and other hosts in the future.
- **simple code structure** - for a simple codebase. Trying to separate in single
  concern files.
- **TDD** - Tests were generated by Claude. They seem good, but have not been vetted 
  in detail. This is a known technical debt.
- **Minimal CI** - GitHub Actions to run all tests. If green we can publish to npm, 
  but npm login hasn't been set up yet.


### Production-readiness signals

The brief asked for these to be "clearly recognizable" without full
implementation. The choices:

| Concern | Approach |
|---|---|
| **Network failures** | 5xx retries with 1s/2s/4s exponential backoff (max 3); 4xx and rate-limit responses not retried (different signal) |
| **Rate limits** | Typed `ProviderRateLimitError` with reset-time hint; `--verbose` surfaces remaining quota per request |
| **Configuration** | Versioned schema (`version: 1`) with precedence CLI > env > file > built-in default; resolver returns per-field source for `config list` |
| **Future providers** | All GitHub specifics behind a `Provider` interface; `provider='github'` hardcoded for now, GitLab can drop in via one switch case |
| **Testability** | `fetch` and `sleep` injected via provider config; pure modules for parse/stats/output/config; ~230 tests including live acceptance tests against `karpathy/nanochat` |
| **CI + release** | Single GitHub Actions workflow runs install/check/typecheck/test/build/smoke; auto-publishes to npm when `package.json` `version` is new; `--provenance` via OIDC |
| **Exit codes** | Standard CLI contract — see the [table below](#exit-codes) |


## Development

Built with **Bun + TypeScript**.

```
bun install
bun test
bun run build           # produces dist/raepo.js
bun run raepo …         # run from source
```

The published npm package ships the bundled JS so it runs on Node too.

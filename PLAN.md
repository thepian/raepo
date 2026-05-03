# PLAN

## Section 1 — Implementation plan (delete when shipped)

The goal is a take-home-quality command-line tool that demonstrably works
against real GitHub repos and shows production sensibility without
over-building. Order is chosen so each step leaves the tool in a runnable
state.

### 1. Project skeleton

- `bun init`, TypeScript strict, Biome for lint/format.
- `package.json`:
  - `"type": "module"`
  - `"bin": { "raepo": "./dist/raepo.js", "ræpo": "./dist/raepo.js" }`
  - `"engines"`: Node ≥ 20 (so the published bundle runs on Node too).
- `src/cli.ts` shebang + stub `--help` / `--version`.
- `tsconfig.json`, `.gitignore`, `LICENSE` (MIT).

### 2. GitHub client (`src/github/`)

- `fetch`-based, no SDK. Bun has fetch builtin.
- Token resolution: `--token` → `GITHUB_TOKEN` → `gh auth token` (shell out;
  fail soft if `gh` missing).
- Pagination via `Link` header, async iterator API:
  `for await (const pr of listPulls(org, repo, { state, since })) …`
- Rate-limit handling:
  - Surface `x-ratelimit-remaining`/`reset` in verbose mode.
  - On 403 with rate-limit body, fail with an actionable message (how long to
    wait, suggest a token).
  - On 5xx, retry with exponential backoff (max 3).
- `--since` short-circuits the iterator — PRs come back newest-first by
  `created`, so we stop when we cross the boundary.

### 3. Domain types & filters (`src/domain.ts`)

- Normalise the GitHub PR shape into a small internal type
  (`{ number, author, createdAt, mergedAt, closedAt, isBot, … }`).
- Pure filter functions: `byAuthor`, `byAge`, `excludeBots`, `byState`.

### 4. Stats (`src/stats/`)

Pure functions, fully unit-tested. No network, no I/O.

- `merged` — count of merged PRs
- `typical` — median time-to-merge
- `average` — mean time-to-merge
- `tail` — p90 time-to-merge
- `accept` — merged / (merged + closed-unmerged)
- `byAuthor(prs) → Map<login, AuthorStats>`
- `summary(prs) → RepoSummary`

Edge cases to handle: empty input, single PR, all-merged, none-merged,
ties at the median.

### 5. Output (`src/output/`)

- `table` — aligned ASCII table, colour via ANSI when stdout is a TTY only.
- `json` — stable schema, version field, no trailing whitespace.
- `csv` — RFC 4180.
- Single-author detail view: small histogram of merge times and a
  recent-PRs list (number, title, days-to-merge).

### 6. CLI wiring (`src/cli.ts`)

- Parse args — likely `mri` or hand-rolled (this CLI is small enough). Avoid
  `commander`/`yargs`-class deps if a 50-line parser does the job.
- Validate: org/repo format, date parsing for `--since`, duration parsing for
  `--max-age` (`30d`, `12w`, `6mo`).
- Mode selection: single `--author` ⇒ detail view; otherwise table.
- Subcommand dispatch: first positional arg is `config` ⇒ config subcommand
  (step 7), otherwise treat as `<org>/<repo>`.
- Exit codes: 0 success, 1 user error, 2 network/rate-limit error.

### 7. Config subcommand (`src/config/`) — skeleton only

Deliberately minimal. Aliases, saved queries, multi-host, etc. live in
section 2.

- File: `~/.raepo/config.json`. Directory created lazily. Same dir will hold
  the cache later — see section 2.
- Schema (all keys optional, validated on read):
  `version` (always `1` in MVP — lets us migrate later without breakage),
  `format`, `sort`, `include-bots`, `concurrency`.
  Unknown keys rejected with a clear message.
- Subcommands (just three):
  - `config get [key]` — print one key, or all if omitted
  - `config set <key> <value>` — coerce value by schema, write the file
  - `config list` — table of key, value, source (config | default)
- Precedence resolved in a single function used by every command:
  CLI flag → env var (`GITHUB_TOKEN`, `RAEPO_*`) → config file → built-in
  default. Make this resolver pure and unit-test it.
- Tokens are intentionally **not** a config key. Use `$GITHUB_TOKEN` or
  `gh auth token`.

### 8. Tests

- `bun test` for stats — table-driven, deterministic.
- One integration test against a recorded fixture for `karpathy/nanochat`
  (varied authors, real-world PR shapes), replayed via a `fetch` stub.
  Snapshot the table output. Fixture-recording script lives at
  `scripts/record-fixture.ts` and is rerunnable; `alexzhang13/rlm` and
  `facebookresearch/perception_models` are documented as alternatives if
  nanochat ever becomes unsuitable.
- CI: GitHub Actions, `bun install && bun test && bun run build`.

### 9. Distribution

- `bun build src/cli.ts --target=node --outfile=dist/raepo.js` — published
  bundle, runs on Node.
- `npm publish` — unscoped `raepo` (name is available; verified via
  registry lookup).
- `package.json` `"bin": { "raepo": "./dist/raepo.js", "ræpo": "./dist/raepo.js" }`.
- GitHub Release with a tag per version; release notes generated from
  commit messages.

(Standalone binaries and Homebrew tap are deliberately deferred to section 2.)

### 10. Polish

- README final pass.
- `--help` text reads well standalone.
- Error messages give the user a next action.
- Exit codes documented.

### Not doing in v1 (called out in roadmap or rejected)

- Caching, retries beyond simple backoff, structured logging, telemetry,
  multi-repo aggregation, GitHub App auth, web UI.
- Standalone binaries via `bun build --compile` and a Homebrew tap.
- **Per-author responsiveness / review-wait / author-wait** — rejected, not
  deferred. The signal is too noisy at the source and the per-author cut
  reads as a performance metric. The honest "where do PRs get stuck" view
  belongs in the repo-aggregate bottleneck view (section 2), not as an
  author column.

---

## Section 2 — Roadmap beyond the take-home

What I'd build if this graduated from a take-home into a real product.

### Caching layer

Merged PRs are immutable. A trivial on-disk cache keyed by PR number + repo
makes repeat queries near-instant and dodges most of the rate limit. SQLite
or just JSON shards under `~/.raepo/cache/<org>/<repo>/` (same root as
config). Invalidate only the "open" and "recently closed" slice on each run.

Config additions: `cache.enabled`, `cache.ttl`, `cache.maxSize`. Sibling
subcommands: `raepo cache clear`, `raepo cache stats`.

### Config: profiles, aliases, saved queries

The MVP config is a flat key/value file. Once the tool gets used regularly,
the surface around it grows naturally:

- **Repo aliases** — `raepo config alias add nano karpathy/nanochat`, then
  `raepo nano --since 7d`. Removes the friction of typing the org/repo for
  the handful you actually live in.
- **Saved queries** — `raepo config query save weekly --since 7d --sort tail`,
  then `raepo --query weekly karpathy/nanochat`. Captures a frequent slice
  without rebuilding the flag soup.
- **Multiple tokens / hosts** — work vs personal GitHub, or
  `ghe.example.com` alongside `github.com`. Token is per-host:
  `raepo config token add work --host ghe.example.com --token …`, then
  `raepo --account work …`. Implies an `apiBase` per host.
- **Bot pattern override** — `excludeBots.patterns` so a team can add
  internal bot logins without a code change.
- **Per-repo defaults** — different sort key or window for different repos
  (`raepo config set --repo karpathy/nanochat sort tail`).
- **Output theming** — colour on/off, locale for date/duration formatting,
  table style (ascii/unicode).

Schema versioning (`version: 1` in MVP) is what lets all of this land
without a painful migration.

### GitHub Enterprise

A single `apiBase` config (or per-host as above) lets raepo run against
self-hosted GHE. Small change in the API client; mostly a test-surface
question (recorded fixtures for both shapes).

### Multi-repo and org-wide

`raepo facebookresearch/*` or `raepo facebookresearch` to aggregate across
an org's repos. Per-author stats roll up; per-repo subtotals available with
`--by repo,author`.

### Trends over time

`--since 2025-01 --bucket month` produces a per-author time series instead of
a single aggregate. Useful for spotting regressions ("our typical merge time
doubled in March") and onboarding effects.

### Bottleneck view

Reframe the same data as repo-health rather than per-author:
- PRs currently stuck (open > p90 of historical merge time)
- Reviewers with longest median response time
- Files / paths that correlate with slow merges

This is the "more honest framing" the README mentions — same data, less
ranking-people energy.

### GitHub App auth

PAT-based auth caps at 5000 req/hour and is awkward to share across a team.
A GitHub App bumps to 15000 req/hour, scopes properly, and lets a hosted
version of raepo run for an org without each user wiring up a token.

### Hosted dashboard

The CLI is the truth; a thin web view on top would let non-CLI users (eng
managers, PMs) see the same numbers. JSON output is already shaped for this.
Likely Astro + a small API that runs raepo on a schedule and caches results.

### CI integration

`raepo ci-check --regression typical:50%` — fail a CI job if typical merge
time has regressed by 50% vs the trailing 90 days. Lets a team set merge-time
SLOs without a separate observability stack.

### Plugin / data export

Stable JSON schema (already planned) + a documented Webhook/Datadog/
Honeycomb export so teams can plug raepo's numbers into their existing
dashboards rather than living in a CLI.

### Cross-platform binaries & auto-update

Bun's `--compile` already produces single binaries. A release script that
builds for darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64 +
a self-update command (`raepo update`) is straightforward and removes the
"is my version current" question.

### Telemetry (opt-in)

Anonymous usage and error reporting (Sentry-style) — strictly opt-in,
documented, off by default. The signal would tell us which flags actually
get used and which surfaces error out in the wild.

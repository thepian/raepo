
## Roadmap

This is a loose plan of ideas for future improvements.


### Tech Stack

- Implemented in TypeScript + Bun as it is what I'm used to day to day. Rust was an
  option, but I don't think it would have made any different. The main performance impact is from network comms.
- Hand-rolled arg parser — 50 lines beats a commander/yargs dep; documented 
  alternatives in a comment
- Biome for lint+format, fast and nice
- Vitest for tests (not bun test) — IDE/ecosystem compat
- No SDK; raw fetch — supply-chain hygiene, no dependencies, predictable security

### Caching layer

Merged PRs are immutable. A trivial on-disk cache keyed by PR number + repo
makes repeat queries near-instant and dodges most of the rate limit. SQLite
or just JSON shards under `~/.raepo/cache/<org>/<repo>/` (same root as
config). Invalidate only the "open" and "recently closed" slice on each run.

It is likely not worth it if API remains fast and reliable.

Config additions: `cache.enabled`, `cache.ttl`, `cache.max-size`. Sibling
subcommands: `raepo cache clear`, `raepo cache stats`.

### Parallel fetch

The `concurrency` config key already exists and is wired through the
resolver — but the GitHub provider still iterates pages serially. Lifting
that is mostly bookkeeping (request-pool + ordering on the consumer side);
the value shows up most on first runs and on multi-repo (below).

### Config: profiles, aliases, saved queries

The MVP config is a flat key/value file. Once the tool gets used regularly,
the surface around it grows naturally:

- **Repo aliases** — `raepo config alias add nano karpathy/nanochat`, then
  `raepo nano --since 7d`.
- **Saved queries** — `raepo config query save weekly --since 7d --sort tail`,
  then `raepo --query weekly karpathy/nanochat`.
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

`version: 1` in the schema today is what lets all of this land later
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

`--since 2025-01 --bucket month` produces a per-author time series instead
of a single aggregate. Useful for spotting regressions ("our typical merge
time doubled in March") and onboarding effects.

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
managers, PMs) see the same numbers. JSON output is already shaped for
this. Likely Astro and push to bunny.net CDN.

### CI integration

`raepo ci-check --regression typical:50%` — fail a CI job if typical merge
time has regressed by 50% vs the trailing 90 days. Lets a team set
merge-time SLOs without a separate observability stack.

### Plugin / data export

Stable JSON schema (already planned) + a documented
Webhook/Datadog/Honeycomb export so teams can plug raepo's numbers into
their existing dashboards rather than living in a CLI.

### Cross-platform binaries & auto-update

Bun's `--compile` already produces single binaries. A release script that
builds for darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64 +
a self-update command (`raepo update`) is straightforward and removes the
"is my version current" question.

### GitHub Releases + changelog

Tag per version, auto-generated release notes from commit messages. Sits
naturally next to the existing publish job in CI.

### Telemetry (opt-in)

Anonymous usage and error reporting (Sentry-style) — strictly opt-in,
documented, off by default. The signal would tell us which flags actually
get used and which surfaces error out in the wild.

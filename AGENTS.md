`raepo` is a command-line tool that pulls pull-request data from GitHub and
reports per-author merge-time statistics. Bun + TypeScript. Published to npm
so `bunx raepo` / `npx raepo` work.

Use **Bun**, not npm/yarn/pnpm, for development. Don't start long-running
servers or watchers unprompted.

## Things to avoid

- **Don't surface mean-only stats.** Always pair `average` with `typical` (and
  `tail` if there's room). PR merge times are heavily skewed.
- **Don't include bots by default** in any aggregation. Default-exclude;
  opt-in via `--include-bots`. Heuristic: `user.type === "Bot"` OR login
  matches `/^(dependabot|renovate|github-actions|.*\[bot\])$/`.
- **Don't frame per-author numbers as performance evaluation.** Merge time is
  a system property, not an author property. README and `--help` should
  reinforce this.
- **Don't paginate naively.** GitHub paginates at 100/page; the closed-PRs
  list can run thousands of pages. Bound concurrency, respect rate-limit
  headers (`x-ratelimit-remaining`, `x-ratelimit-reset`), and stop early when
  PRs fall outside the `--since` window.
- **Don't add per-author "responsiveness" or "review-wait" metrics.** They
  were considered and rejected: the data is noisy at the source (no clean
  "ready for re-review" signal in GitHub) and per-author cuts read as a
  performance metric no matter how they're labelled. If a "where do PRs get
  stuck" view ships, do it as a repo-aggregate bottleneck view, not a
  per-author column.

## Code conventions

- Strict TypeScript. No `any` without a comment explaining why.
- Pure stats functions live in `src/stats/` and have unit tests. Network code
  lives in `src/github/` and is mockable.
- CLI entry point in `src/cli.ts`. Argument parsing thin; business logic in
  modules.
- Default to writing no comments. Explain *why* only when it's non-obvious.
- Minimal dependencies. Bun's stdlib covers HTTP, file I/O, and testing.

## Testing

- **Unit tests** for stats functions — pure, fast, deterministic.
- **One integration test** that replays a recorded GitHub HTTP fixture.
  Don't hit the live API in CI.


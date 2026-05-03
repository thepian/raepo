---
name: github-pr
description: How to consume the GitHub Pull Requests REST API — endpoints, query parameters, pagination via Link headers, the merged-vs-closed state model, bot/null-user detection, the "Pull Request Simple" vs full PR shape, and the gotchas that actually bite (no `since` filter, no author filter, list endpoint omits additions/deletions/merged_by, rate-limit headers inconsistently present on unauthenticated calls). Use this skill whenever building or debugging code that fetches, paginates, or aggregates PR data from GitHub — including any tool that calls `/repos/{owner}/{repo}/pulls`, computes per-author stats, measures merge time, builds throughput dashboards, or analyzes review patterns. Trigger even when the user doesn't say "API" or "REST" explicitly — phrases like "PR analytics tool", "merge time CLI", "GitHub PR stats", "fetch all merged PRs", "who's slow at reviewing", or any code talking to api.github.com about pull requests should pull this in.
---

# GitHub PR REST API — what to know before building

A condensed reference for code that consumes GitHub's PR data. The official docs cover every field; this skill covers the **shape of the API**, the **gotchas that aren't obvious from reading docs**, and the **patterns that actually work in practice**.

## Quick reference

| Need | Endpoint | Notes |
|---|---|---|
| List PRs in a repo | `GET /repos/{owner}/{repo}/pulls` | Returns "Pull Request Simple"; the workhorse |
| Single PR (full) | `GET /repos/{owner}/{repo}/pulls/{n}` | Has `additions`, `deletions`, `merged_by`, `commits` |
| Reviews on a PR | `GET /repos/{owner}/{repo}/pulls/{n}/reviews` | One call per PR — N+1 |
| Search PRs by author | `GET /search/issues?q=is:pr+author:X+repo:Y` | Separate, lower rate limit (30/min) |
| Confirm a user is a bot | `GET /users/{login}` | Returns `type: "User" \| "Bot" \| "Organization"` |

Required headers on every call:

```http
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
User-Agent: <your-tool-name>
Authorization: Bearer <token>          # optional, but heavily recommended
```

Skipping `User-Agent` will fail. Skipping `Authorization` works but caps you at 60 req/hour.

If you need PR bodies rendered (markdown → html, text-only, etc.), the list endpoint also supports `application/vnd.github.raw+json`, `vnd.github.text+json`, `vnd.github.html+json`, and `vnd.github.full+json` Accept variants. For analytics that ignore PR body content, the standard `application/vnd.github+json` is all you need.

## The list endpoint

`GET /repos/{owner}/{repo}/pulls`

### Query parameters

| Param | Default | Values | Notes |
|---|---|---|---|
| `state` | `open` | `open` \| `closed` \| `all` | **Default catches you out** — set explicitly |
| `head` | — | `user:branch` or `org:branch` | Filter by source branch |
| `base` | — | branch name | Filter by target branch |
| `sort` | `created` | `created` \| `updated` \| `popularity` \| `long-running` | `long-running` is a hidden gem (PRs open >1 month with recent activity — useful for "what's stuck" views) |
| `direction` | `desc` if `sort=created`, else `asc` | `asc` \| `desc` | |
| `per_page` | `30` | 1–100 | Always set to 100 — the default silently triples your request count |
| `page` | `1` | int | Standard pagination |

### What's NOT a query parameter (and how to work around it)

These omissions are the source of most "why doesn't my code work" moments.

**No date-range filter.** No `since`, no `created_after`, no `updated_since`. The standard pattern: sort by `created desc` and stop iterating when you cross your boundary. The `Link: rel="next"` header keeps coming, so you have to break the loop yourself. This works *only* because the order is guaranteed — if you ever change the sort, the date filter silently breaks.

**No author filter.** Author info is in the response but not a query parameter. Two options:
1. Filter client-side after collecting (simple, expensive at scale)
2. Use `/search/issues` with `q=is:pr+author:LOGIN+repo:OWNER/REPO` — separate rate limit (30/min), but cuts data volume

**No merged-vs-not filter.** There's no `state=merged`. Pass `state=closed` and partition the results on `merged_at !== null` (see "State model").

## State model — merged vs closed

GitHub PRs have only **two** states: `open` and `closed`. There is no "merged" state.

- A merged PR is automatically closed by the merge.
- `merged_at` is a separate timestamp: a date if merged, `null` if not.

Implications worth internalizing:

- merged ⇒ closed (always)
- closed ⇏ merged (could be closed without merging)
- The merged signal is `merged_at !== null`. `merge_commit_sha` is also a valid signal but `merged_at` is canonical.
- To get every merged PR, fetch `state=closed`. You don't need a separate query for "merged" because there is no such state.
- `state=closed` returns *both* merged and closed-without-merging PRs — exactly what you need for acceptance-rate denominators.

## "Pull Request Simple" vs full "Pull Request"

The list endpoint returns a slim shape called **Pull Request Simple**. The single-PR endpoint returns the full **Pull Request** with extra fields. This split is deliberate — and it's the source of the biggest scaling gotcha.

**Available on the list endpoint:**
`number`, `title`, `body`, `state`, `user`, `created_at`, `updated_at`, `closed_at`, `merged_at`, `html_url`, `draft`, `labels`, `milestone`, `assignees`, `requested_reviewers`, `requested_teams`, `head`, `base`, `_links`, `author_association`, `auto_merge`, `locked`, plus various URLs.

**Only on the single-PR endpoint** (`GET /pulls/{n}`):
`additions`, `deletions`, `changed_files`, `merged_by`, `commits`, `comments`, `review_comments`, `mergeable`, `mergeable_state`, `rebaseable`, `maintainer_can_modify`.

If you need any of those, expect **N+1 calls**. Plan accordingly: a 5000-PR repo at 5000 req/hr (PAT) means an hour of authenticated requests just for enrichment. For most analytics use cases (merge time, acceptance rate, per-author counts), the list endpoint is enough.

## Pagination

GitHub uses RFC 5988-style `Link` response headers:

```
Link: <https://api.github.com/...?page=2>; rel="next", <https://api.github.com/...?page=127>; rel="last"
```

Extract the `next` URL with a regex and follow until absent. **Don't compute `?page=N` URLs yourself** — let the server give them to you. The `next` URL preserves all your query parameters (state, sort, etc.) and survives any future API changes to pagination.

```ts
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return m ? m[1] : null;
}
```

When iterating, the natural shape is an async iterator that yields PRs one at a time, with the option to break out early (e.g. for the date-range workaround above):

```ts
async function* listPulls(repo, opts) {
  let url = buildFirstPageUrl(repo, opts);
  while (url !== null) {
    const res = await fetch(url, { headers: ... });
    if (!res.ok) throw toError(res);
    for (const pr of await res.json()) {
      yield normalize(pr);
    }
    url = nextPageUrl(res.headers.get('link'));
  }
}
```

## Authors, bots, and ghosts

The `user` object has `login`, `type`, and `id`. You'll see:

| `type` | When |
|---|---|
| `User` | A human account |
| `Bot` | A GitHub App acting on the user's behalf (dependabot, renovate, github-actions, etc.) |
| `Organization` | Rare on PRs |

**`user: null`** happens when the original account was deleted (the "ghost" case). Rare on closed PRs but possible — handle defensively (treat as login `"ghost"`, never as a bot).

**Bot detection:**
1. Primary: `user.type === "Bot"`. Confirmed in the wild for dependabot and renovate.
2. Defensive fallback: login matches `/^(dependabot|renovate|github-actions)$/i` or ends in `[bot]`. Useful for stale data or bots that haven't been recategorized.

For analytics, **default-exclude bots**. In active OSS repos, dependabot alone often outproduces every human contributor and will dominate any per-author table.

## Rate limits

| Auth | Limit/hour |
|---|---|
| Unauthenticated | 60 |
| Personal access token | 5000 |
| GitHub App (installation token) | 15000 |
| Search API (any auth) | 30/minute (separate budget) |

Each response *should* include:

- `x-ratelimit-limit` — the ceiling
- `x-ratelimit-remaining` — what's left
- `x-ratelimit-reset` — Unix epoch seconds when the window resets

**Caveat that bites:** these headers are inconsistently present on unauthenticated GETs to public endpoints. Don't rely solely on header polling for rate-limit detection — also check status code and body:

```ts
function isRateLimit(res: Response): boolean {
  if (res.status !== 403) return false;
  return res.headers.get('x-ratelimit-remaining') === '0';
}
```

The reset time:

```ts
const reset = res.headers.get('x-ratelimit-reset');
const resetAt = reset ? new Date(Number(reset) * 1000) : null;
```

### Conditional requests (free re-fetches)

The list endpoint supports ETag / `If-None-Match`. A `304 Not Modified` response means "nothing changed since your ETag" and **doesn't count against your rate limit**. For workloads that re-fetch the same windows (dashboards, polling jobs, regularly-run reports), this is a huge win.

Cache the ETag alongside the response. On the next request:

```http
If-None-Match: W/"4873bc9701f02f5..."
```

If the data hasn't changed, you get 304 and can serve the cached body. If it has, you get 200 + new body + new ETag.

## Errors

GitHub error responses are JSON:

```json
{
  "message": "Not Found",
  "documentation_url": "https://docs.github.com/...",
  "status": "404"
}
```

| Status | Meaning | Source |
|---|---|---|
| `200` | OK | endpoint-documented |
| `304` | Not Modified (conditional request hit cache; doesn't count vs rate limit) | endpoint-documented |
| `422` | Validation failed *or* "endpoint has been spammed" (soft rate signal) | endpoint-documented |
| `401` | Unauthorized (bad/expired token) | general API |
| `403` | Forbidden (rate limit, abuse detection, or actual permissions) | general API |
| `404` | Repo not found OR you lack access (private repo without the right token scope) | general API |
| `5xx` | GitHub-side; retry with exponential backoff (max 3) | general API |

The "endpoint-documented" rows are what the official docs explicitly list for this endpoint; the rest are general GitHub API errors that can occur on any endpoint.

A `404` on a private repo can mean "you don't have access" rather than "doesn't exist" — GitHub deliberately blurs the two to avoid leaking repo existence. Surface this in error messages: "404 — repo not found, or token lacks access".

## Real-world data shape

What you actually see when probing live repos:

- **Acceptance rates are often well below 50%.** Microsoft TypeScript: ~26% of recently closed PRs were merged. This makes acceptance rate a meaningful per-author stat, not a rounding artifact near 100%.
- **Merge times are long-tailed.** Even on healthy repos like TypeScript, recent merges range from ~18 minutes to ~7 days. Show median (typical) *and* a tail percentile (p90), not just mean.
- **Drafts exist but are uncommon (~7%).** They're closed/merged like any other PR; no special handling needed unless you have a specific reason to filter them.
- **Bots dominate dependency-heavy repos.** Default-exclude unless told otherwise.

## Authentication patterns

**For local CLI tools**, the standard token resolution chain is:

1. `--token` flag (if provided)
2. `$GITHUB_TOKEN` environment variable
3. `gh auth token` (shell out to the GitHub CLI if installed and authenticated)

The third step lets users avoid configuring a separate token if they already have `gh` set up. It's a small subprocess call (`gh auth token`) and worth the UX win.

```ts
async function resolveToken(flag?: string): Promise<string | undefined> {
  if (flag) return flag;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await spawn('gh', ['auth', 'token']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;  // gh not installed or not authenticated
  }
}
```

**For GitHub Apps**, use installation tokens. Higher rate limit (15000/hr), proper scoping, and avoids the "whose token is this anyway" problem in shared deployments.

### Token scope / permission

The `/pulls` endpoint accepts:

- **GitHub App user access tokens**, **GitHub App installation access tokens**, and **fine-grained personal access tokens**. The token must grant the **"Pull requests" repository permission (read)**.
- **Classic personal access tokens** with `public_repo` (public repos only) or `repo` (private repos too).
- **No auth at all** — works for public repos, capped at 60 req/hour.

If a user reports `403`-with-a-real-message (not rate limit) or `404` on a repo they expect to access, missing token permission is the usual culprit.

## Common gotchas (the things that bite)

1. **Default `state=open`.** Easy to forget when you're looking for merged PRs and get nothing back. Always set state explicitly.
2. **Default `per_page=30`.** Silently triples your request count. Set to 100.
3. **Sort/iteration coupling.** If you synthesize a `since` filter via early termination, you depend on `sort=created&direction=desc`. Change the sort and the date filter silently breaks.
4. **Rate-limit headers absent on unauthenticated GETs.** Don't rely on header presence alone — also check status + body.
5. **N+1 for any per-PR enrichment.** Plan upfront whether you need additions/deletions/merged_by. If not, stay on the list endpoint.
6. **`user` can be null.** Handle the ghost case explicitly.
7. **404 ambiguity on private repos.** "Repo not found" and "no access" return identical responses. Hint at both in error messages.
8. **Bot PRs swamp human stats.** Default-exclude unless the user opts in.

## When to reach beyond `/pulls`

The list endpoint can't do everything. Reach for:

- **`/search/issues`** when you need to filter by author, label, or full-text at the API level. Lower rate limit (30/min) but cuts data volume dramatically.
- **`/pulls/{n}`** when you need additions/deletions/merged_by/commits.
- **`/pulls/{n}/reviews`** for review history. **Caution:** per-author review-wait metrics are easy to weaponize and noisy at the source (no clean "ready for re-review" event in GitHub). If you build it, be honest about the limits.
- **`/repos/{owner}/{repo}/issues`** confusingly also returns PRs (they're a subset of issues internally) — if you want PRs only, use `/pulls`. The issues endpoint includes a `pull_request` field on items that are actually PRs.

## Common pattern: per-author PR analytics

If you're building a tool that aggregates PR merge stats — per-author tables, repo throughput dashboards, merge-time CLIs — the assembled recipe is:

1. **Endpoint:** `GET /repos/{owner}/{repo}/pulls`
2. **`state=closed`** — covers both merged and closed-without-merging. You need both: merged for time stats, the union for the acceptance-rate denominator. Don't fetch `state=open` separately unless you have a specific reason.
3. **`sort=created&direction=desc`** — newest-first iteration order. The date-filter workaround depends on it; change the sort and your `--since` silently breaks.
4. **`per_page=100`** — the default of 30 silently triples your call count.
5. **Iteration with early termination** for `--since` / `--max-age`: stop pulling pages the moment you yield a PR older than the boundary. Combine `--since` and `--max-age` by taking `max(since, now − maxAge)` as the effective floor before passing to the iterator.
6. **Client-side filters after collection** (the API can't do these):
   - **Authors** (allowlist) — server has no author param. Filter the collected array, or use `/search/issues` if data volume hurts.
   - **Bots** — exclude by default. `user.type === "Bot"` is the primary signal; regex (`dependabot|renovate|github-actions|*[bot]`) as a fallback.
   - **Drafts** — usually treat as regular PRs. Add a flag if a use case appears.
7. **Stats partition** (after filtering):
   - **Time stats** (typical / average / tail merge-time) — only count PRs where `merged_at !== null`.
   - **Acceptance rate** — `merged / (merged + closed-unmerged)`. Both buckets contribute to the denominator.
   - **Per-author counts** — group filtered array by `user.login`.
8. **Eager collection is fine for MVP.** ~50 MB for 100k PRs of slim shape; fits comfortably in memory. Switch to streaming aggregators only if you outgrow it.
9. **Don't fetch per-PR detail** unless you actually need additions/deletions/merged_by/commits — every enrichment is N+1, an hour of API budget for a 5000-PR repo on a PAT.
10. **Progress feedback**: emit a stderr counter (e.g., `\rfetched 1200 PRs…`) gated on `process.stderr.isTTY` so JSON output stays clean when piped.

This recipe matches what tools like raepo are built on. Any deviation should have a reason recorded — usually a specific feature requirement that the recipe doesn't cover.

## See also

- Official docs: <https://docs.github.com/en/rest/pulls/pulls>
- Authentication: <https://docs.github.com/en/rest/overview/authenticating-to-the-rest-api>
- Rate limits: <https://docs.github.com/en/rest/rate-limit/rate-limit>
- Conditional requests: <https://docs.github.com/en/rest/overview/resources-in-the-rest-api#conditional-requests>
- Pagination: <https://docs.github.com/en/rest/guides/using-pagination-in-the-rest-api>
- Search API: <https://docs.github.com/en/rest/search/search>

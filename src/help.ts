import type { Command, ParsedArgs } from './command';

const HELP = `raepo — per-author PR merge-time stats from GitHub.

Usage
  raepo <org>/<repo> [options]
  raepo config <get|set|list> [args]

Filters
  --since <date>          Only PRs created on or after <date> (YYYY-MM-DD)
  --max-age <duration>    Only PRs created within <duration> (e.g. 30d, 12w, 6mo, 1y)
  --author <list>         Restrict to author(s). Comma-separated and/or
                          repeatable: --author alice,bob --author carol
  --include-bots          Include bot accounts (excluded by default)

Output
  --format <f>            plain | json | csv  (default: plain)
  --sort <key>            merged | typical | average | tail | accept
                          (default: merged, descending)
  --limit <n>             Show top n authors (table view only)

Auth
  --token <pat>           GitHub personal access token. Resolution order:
                          --token  >  $GITHUB_TOKEN  >  \`gh auth token\`
                          Anonymous works for public repos (60 req/hour).

Other
  --verbose, -v           Print per-request rate-limit info to stderr
  --help, -h              Show this help
  --version, -V           Show version

View modes (plain format only)
  No --author filter      Table; authors with no merged PRs go in a compact
                          "No accepted PRs" line below.
  Multiple --author       Table including every specified author (no demotion).
  Single --author         Vertical label:value detail view for that author.

Config
  raepo config get [key]  Print one key, or all set keys (key=value lines)
  raepo config set <k> <v>  Persist a default to ~/.raepo/config.json
  raepo config list       Table of key, value, source (env | config | default)

  Keys: format | sort | include-bots | concurrency
  Precedence: CLI flag > RAEPO_* env > config file > built-in default

Examples
  raepo karpathy/nanochat
  raepo karpathy/nanochat --since 2026-01-01 --limit 10
  raepo karpathy/nanochat --max-age 90d --sort typical
  raepo karpathy/nanochat --author svlandeg
  raepo karpathy/nanochat --author alice,bob,carol
  raepo karpathy/nanochat --format json | jq '.authors[]'
  GITHUB_TOKEN=ghp_xxx raepo myorg/private-repo
  raepo config set format json
`;

export function buildHelp(_: ParsedArgs): Command {
  return {
    mode: 'help',
    async run() {
      process.stdout.write(HELP);
      return 0;
    },
  };
}

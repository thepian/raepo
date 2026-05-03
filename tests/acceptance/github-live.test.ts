import { describe, expect, it } from 'vitest';
import { createProvider } from '../../src/provider/index.ts';
import type { PullRequest } from '../../src/provider/types.ts';

/**
 * Live smoke test against the public GitHub API.
 *
 * - Hits `karpathy/nanochat` (a real, public, active repo).
 * - One page, then breaks — one API call total.
 * - Uses GITHUB_TOKEN if present (higher rate limits in CI), else unauthenticated.
 * - Skip with `RAEPO_SKIP_LIVE=1` (e.g. when offline).
 */
describe.skipIf(process.env.RAEPO_SKIP_LIVE === '1')('github provider — live', () => {
  it('lists at least one PR from karpathy/nanochat with a sensible shape', async () => {
    const token = process.env.GITHUB_TOKEN;
    const provider = createProvider({
      provider: 'github',
      ...(token ? { token } : {}),
    });

    let first: PullRequest | undefined;
    for await (const pr of provider.listPulls({ org: 'karpathy', name: 'nanochat' })) {
      first = pr;
      break;
    }

    expect(first, 'expected at least one PR; got none').toBeDefined();
    if (!first) return;

    expect(first.number).toBeGreaterThan(0);
    expect(first.title).toBeTypeOf('string');
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.author.login).toBeTypeOf('string');
    expect(first.author.login.length).toBeGreaterThan(0);
    expect(first.author.isBot).toBeTypeOf('boolean');
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(first.createdAt.getTime())).toBe(false);
    // state=closed by default → closedAt should be populated
    expect(first.closedAt).toBeInstanceOf(Date);
    // mergedAt may be null (closed without merging) or a Date
    if (first.mergedAt !== null) {
      expect(first.mergedAt).toBeInstanceOf(Date);
    }
    expect(first.url).toMatch(/^https:\/\/github\.com\/karpathy\/nanochat\/pull\/\d+$/);
  }, 15000);
});

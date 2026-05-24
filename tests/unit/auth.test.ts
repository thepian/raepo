import { describe, expect, it, vi } from 'vitest';
import { resolveToken } from '../../src/auth.ts';

describe('resolveToken', () => {
  it('returns the flag when given (and skips env + provider call)', async () => {
    const providerTokenFn = vi.fn();
    const token = await resolveToken({
      flag: 'flag-token',
      env: { GITHUB_TOKEN: 'env-token' },
      providerName: 'github',
      providerTokenFn,
    });
    expect(token).toBe('flag-token');
    expect(providerTokenFn).not.toHaveBeenCalled();
  });

  it('returns $GITHUB_TOKEN when no flag (and skips provider call)', async () => {
    const providerTokenFn = vi.fn();
    const token = await resolveToken({
      env: { GITHUB_TOKEN: 'env-token' },
      providerName: 'github',
      providerTokenFn,
    });
    expect(token).toBe('env-token');
    expect(providerTokenFn).not.toHaveBeenCalled();
  });

  it('falls back to the provider token function when no flag/env', async () => {
    const providerTokenFn = vi.fn().mockResolvedValue('gh-token');
    const token = await resolveToken({
      env: {},
      providerName: 'github',
      providerTokenFn,
    });
    expect(token).toBe('gh-token');
    expect(providerTokenFn).toHaveBeenCalledWith('github');
  });

  it('returns undefined when nothing resolves a token', async () => {
    const providerTokenFn = vi.fn().mockResolvedValue(undefined);
    const token = await resolveToken({
      env: {},
      providerName: 'github',
      providerTokenFn,
    });
    expect(token).toBeUndefined();
  });

  it('returns undefined when no providerName is given and no flag/env', async () => {
    const token = await resolveToken({ env: {} });
    expect(token).toBeUndefined();
  });

  it('treats an empty string env var as "not set"', async () => {
    const providerTokenFn = vi.fn().mockResolvedValue('gh-token');
    const token = await resolveToken({
      env: { GITHUB_TOKEN: '' },
      providerName: 'github',
      providerTokenFn,
    });
    expect(token).toBe('gh-token');
  });
});

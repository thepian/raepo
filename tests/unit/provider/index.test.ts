import { describe, expect, it } from 'vitest';
import { createProvider, DEFAULT_PROVIDER } from '../../../src/provider/index.ts';

describe('createProvider', () => {
  it('returns a GitHub provider for provider=github', () => {
    const p = createProvider({ provider: 'github' });
    expect(p.name).toBe('github');
    expect(typeof p.listPulls).toBe('function');
  });

  it('the default provider is github (until a second one lands)', () => {
    expect(DEFAULT_PROVIDER).toBe('github');
  });
});

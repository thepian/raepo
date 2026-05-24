import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 15000,
    // Keep ANSI styling out of unit-test output so substring/length assertions
    // stay deterministic. picocolors honours NO_COLOR.
    env: { NO_COLOR: '1' },
  },
});

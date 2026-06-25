import { defineConfig } from 'vitest/config';

// Provider tests — spend real API tokens. Run with `pnpm test:providers`.
// Excluded from the default `pnpm test` run via the main vitest config.

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    include: ['src/**/*.providers.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});

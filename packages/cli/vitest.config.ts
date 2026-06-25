import { defineConfig } from 'vitest/config';

// Unit-test config: excludes integration tests (`*.int.test.ts`, which spin up
// testcontainers and must run single-fork via vitest.int.config.ts to avoid
// port contention) and provider tests (`*.providers.test.ts`, which spend real
// API tokens — run with `pnpm test:providers`). The `pnpm test` script chains
// `test:unit && test:int` so the full suite still runs locally.

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts', '**/*.providers.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});

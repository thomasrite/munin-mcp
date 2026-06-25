import { defineConfig } from 'vitest/config';

// Unit-test config: excludes integration tests (`*.int.test.ts`, which spin up
// testcontainers and run single-file via vitest.int.config.ts). Mirrors the
// munin-mcp configs.

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});

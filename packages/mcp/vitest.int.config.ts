import { defineConfig } from 'vitest/config';

// Integration-test config: only *.int.test.ts files. These spin up a real
// Postgres (testcontainers + pgvector); `fileParallelism: false` serialises
// the files so at most one container runs at a time. Mirrors munin-mcp.

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    include: ['src/**/*.int.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

// Integration-test config: only files matching *.int.test.ts. These tests
// spin up real infrastructure (testcontainers + Postgres+pgvector) and are
// slower than unit tests. Run them with `pnpm test:int`.
//
// `fileParallelism: false` serializes the int files so at most ONE Postgres
// testcontainer starts at a time (Vitest-4 clean form; replaces the
// deprecated `poolOptions.forks.singleFork` — mirrors the engine's config).

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    include: ['src/**/*.int.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

// Default vitest config — UNIT tests only (excludes integration + provider
// tests). Integration tests run via `vitest.int.config.ts` (single fork; see
// below). Provider tests (`*.providers.test.ts`, real API spend) run via
// `test:providers`. The package `test` script chains unit + int so a single
// `pnpm test` covers both.
//
// F28 (test-infra): each `*.int.test.ts` starts its own Postgres testcontainer
// in `beforeAll`. Run with vitest's default file-parallelism, many containers
// start at once and the suite fails on `beforeAll` startup-hook TIMEOUTS (not
// assertion failures). The fix keeps unit tests fully parallel (fast, no
// containers) and runs the int suite in a SINGLE fork (vitest.int.config.ts),
// so at most one Postgres container starts at a time — removing the
// thundering-herd contention. The serialized int wall-clock cost is the
// deliberate trade for reliability; a shared/reused container would be faster
// but needs per-file DB isolation to be safe under parallelism (deferred).

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.providers.test.ts', '**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

// `pnpm --filter munin-mcp migrate` — apply pending DB migrations locally.
//
// Thin runnable wrapper. The migration logic AND the migrations folder live in
// the engine (`@muninhq/engine/db/migrate` → `runMigrations`); the integration
// tests call `runMigrations` directly. This is the operator/dev entry point.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

import { runMigrations } from '@muninhq/engine/db/migrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

const url = process.env.DATABASE_URL ?? 'postgres://munin:munin@localhost:5432/munin';
runMigrations(url).then(
  () => {
    console.log(`migrations applied against ${url}`);
    process.exit(0);
  },
  (err) => {
    console.error('migration failed:', err);
    process.exit(1);
  },
);

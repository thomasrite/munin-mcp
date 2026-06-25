// Programmatic migration runner: `runMigrations`.
//
// Connects to Postgres, ensures the `vector` extension exists, then runs every
// pending migration from `src/db/migrations` (the folder lives next to this
// file and is resolved relative to it, so callers in other packages get the
// right migrations).
//
// Used in three places:
//   - the `munin-mcp` `migrate` command for local development
//   - the testcontainers integration tests (which import `runMigrations`
//     directly)
//   - the deployment process in Phase 5 (same library function, different env)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    // pgvector ships in the pgvector/pgvector image but the extension is not
    // enabled by default; first migration step is to enable it. Runs
    // outside the Drizzle migrations dir so that Drizzle's generated DDL
    // can use the `vector` type immediately.
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector;');
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

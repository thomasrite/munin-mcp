// PGlite bootstrap for the local/desktop runtime (P1).
//
// PGlite is real Postgres compiled to WASM, running IN-PROCESS — single
// connection, single process. That is correct for one local user (the free/
// local tier and the foundation for a desktop app), NOT the hosted multi-tenant
// server. This module does BOOTSTRAP, not a new store: it creates a PGlite
// instance with the pgvector extension loaded, wraps it in Drizzle, ensures the
// `vector` extension, runs the EXISTING migrations UNCHANGED, and returns the
// SAME `PostgresGraphStore` over the PGlite handle. There is deliberately no
// second store class and no second permission path — the SQL is identical, so
// the P0 permission/no-leak and pgvector guarantees carry over for free.
//
// The migrations are run unchanged on purpose: diverging them (swapping the HNSW
// index, dropping a trigger, changing the english tsvector config) would alter
// retrieval behaviour and the P0 vector/permission guarantees. If a migration
// ever fails on PGlite, that is a STOP-and-report decision for the maintainer,
// not a silent divergence.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { type PgliteDatabase, drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { LocalStoreUnavailableError } from './errors';
import { PostgresGraphStore } from './postgres-graph-store';

// The SAME migrations folder the hosted Postgres path runs, resolved relative to
// this file so a built dist finds them next to the engine (mirrors db/migrate.ts).
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

export interface PgliteGraphStoreOptions {
  // Filesystem directory for the PGlite data dir. Omit (or undefined) for an
  // in-memory database — used by tests and ephemeral local sessions.
  readonly dataDir?: string;
}

export interface PgliteGraphStoreHandle {
  readonly store: PostgresGraphStore;
  // The raw Drizzle handle, exposed so callers that build sibling stores over
  // the same connection (e.g. the web app's tenant directory) can reuse it.
  readonly db: PgliteDatabase;
  readonly client: PGlite;
  readonly close: () => Promise<void>;
}

// Create a PGlite-backed GraphStore: load pgvector, enable the extension, run
// the existing migrations, and return the reused PostgresGraphStore. Async
// because PGlite init + migration are async.
export async function createPgliteGraphStore(
  options: PgliteGraphStoreOptions = {},
): Promise<PgliteGraphStoreHandle> {
  const client = new PGlite({
    // Undefined dataDir → in-memory PGlite. A path → durable local storage.
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    // Registers the pgvector bundle so `CREATE EXTENSION vector` can succeed.
    extensions: { vector },
  });

  try {
    // Migration 0000 declares `vector(1024)` but does NOT `CREATE EXTENSION` — on
    // the hosted path the extension is enabled out-of-band before migrations
    // (db/migrate.ts). Mirror that here so the vector type is usable before the
    // Drizzle migrator runs.
    await client.exec('CREATE EXTENSION IF NOT EXISTS vector;');

    const db = drizzle(client);
    await migrate(db, { migrationsFolder });

    return {
      store: new PostgresGraphStore(db),
      db,
      client,
      close: () => client.close(),
    };
  } catch (err) {
    // A migration / extension failure is a designed STOP path (see header). Close
    // the WASM client so a half-initialised instance — and, on the dataDir path,
    // its filesystem lock — is not leaked before the error propagates.
    await client.close().catch(() => {});

    // The WASM `RuntimeError: Aborted()` signature is what a locked/corrupt
    // on-disk pgdata produces on open (most often a second process opening the
    // same data dir — F71). Translate ONLY that case into a typed, actionable
    // error; genuinely different migration errors propagate unchanged so they
    // are not masked.
    if (isPgliteAbortError(err)) {
      throw new LocalStoreUnavailableError(
        'the local database could not be opened — it is locked or corrupt. ' +
          'Make sure no other Munin process is using it (stop your AI client, and any running ingest/extract), then try again. ' +
          'If the problem persists, the local data directory may be corrupt and need rebuilding.',
        { cause: err },
      );
    }
    throw err;
  }
}

// Recognise the WASM abort / corruption signature PGlite raises when it cannot
// open an on-disk pgdata (e.g. a second process already holds it). PGlite throws
// a bare `RuntimeError: Aborted(...)` from the Emscripten runtime; match on the
// name and the "Aborted" marker rather than an error class we cannot import.
function isPgliteAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name ?? '';
  const message = err.message ?? '';
  return name === 'RuntimeError' || /\bAborted\b/i.test(message);
}

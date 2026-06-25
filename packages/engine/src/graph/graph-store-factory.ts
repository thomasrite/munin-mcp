// GraphStore factory — selects the backing database driver by environment,
// mirroring the provider-factory / blob-storage-factory pattern. The hosted
// Postgres path is the DEFAULT and is untouched; the local/desktop runtime (P1)
// opts in with GRAPH_STORE=local (PGlite, in-process, zero network).
//
// Both branches return the SAME PostgresGraphStore — the local runtime reuses
// the hosted store unchanged (PGlite is real Postgres compiled to WASM), so the
// P0 permission/no-leak guarantees are identical regardless of backend. The
// handle carries `close` so call-sites dispose the connection cleanly.

import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { AuditedGraphStore } from './audited-graph-store';
import { LocalStoreUnavailableError } from './errors';
import type { GraphStore } from './graph-store';
import { PostgresGraphStore } from './postgres-graph-store';
import { BatchedReadAuditWriter, readAuditEnabled } from './read-audit';

// Re-exported from the `@muninhq/engine/graph-store` subpath (the local-mode entry
// point) so CLI / MCP callers can catch the two local-store failure modes (F71)
// without importing the engine root. LocalStoreLockedError = another live process
// holds the local store; LocalStoreUnavailableError = the local store is locked
// or corrupt and could not be opened. `inspectLock` is the read-only probe that
// lets a caller (e.g. `munin mcp doctor`) detect a live holder WITHOUT opening
// PGlite — so it can report "in use by your AI client" instead of a scary corrupt
// warning, and never risk a destructive concurrent open against a held data dir.
export { LocalStoreLockedError, inspectLock } from './pglite-lock';
export { LocalStoreUnavailableError };

// The raw Drizzle handle behind the store — either driver. TYPE-only imports,
// so the PGlite/WASM bundle still loads only when local mode is selected.
export type GraphStoreDb = PostgresJsDatabase | PgliteDatabase;

export interface GraphStoreHandle {
  // The interface, not the concrete adapter: when read auditing is on
  // (MUNIN_READ_AUDIT, default — F10/F26) the handle carries the
  // AuditedGraphStore decorator over the raw store.
  readonly store: GraphStore;
  // The raw Drizzle handle, exposed so callers that build sibling stores or
  // cross-store orchestrations over the SAME connection (the LearningStore, the
  // retention sweep) can do so — mirrors PgliteGraphStoreHandle.db.
  readonly db: GraphStoreDb;
  // The ONE shared read-audit writer behind `store` (F10/F26), or null when read
  // auditing is off (MUNIN_READ_AUDIT=false). Exposed so a caller that builds
  // per-transaction stores over the SAME connection (e.g. the web app's
  // withEngineTransaction) can wrap them with this SAME writer — one trail, no
  // second writer, no double-audit. close() already drains it; callers reusing it
  // must NOT close it themselves.
  readonly readAudit: BatchedReadAuditWriter | null;
  readonly close: () => Promise<void>;
}

// Default local data dir. Durable PGlite storage under the working directory so
// a local session keeps its graph across runs (override with PGLITE_DATA_DIR).
const DEFAULT_PGLITE_DATA_DIR = './.munin-local/pgdata';

// Selects the GraphStore backend from `GRAPH_STORE`:
//   - unset / 'postgres' (default) → node-postgres against DATABASE_URL (hosted)
//   - 'local'                      → PGlite in-process (local/desktop, P1)
export async function loadGraphStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GraphStoreHandle> {
  const impl = (env.GRAPH_STORE ?? 'postgres').toLowerCase();
  switch (impl) {
    case 'postgres': {
      const url = env.DATABASE_URL?.trim();
      if (!url) {
        throw new Error('GRAPH_STORE=postgres (the default) requires DATABASE_URL to be set.');
      }
      return withReadAudit(PostgresGraphStore.fromConnectionString(url, { max: 5 }), env);
    }
    case 'local': {
      const dataDir = env.PGLITE_DATA_DIR?.trim() || DEFAULT_PGLITE_DATA_DIR;
      // Advisory inter-process lock on the on-disk pgdata (F71): PGlite is single-
      // process, and two processes opening the same data dir corrupt/lock it. We
      // acquire BEFORE opening PGlite (so a held lock refuses cleanly with a typed
      // LocalStoreLockedError instead of a raw WASM abort) and release it in
      // close() — wrapped so a failing close still releases the lock. The lock is
      // a no-op for an in-memory data dir (nothing to lock). LOCAL-ONLY — the
      // hosted Postgres branch above manages its own concurrency and never locks.
      const { acquireLocalStoreLock } = await import('./pglite-lock');
      const lock = await acquireLocalStoreLock(dataDir);
      // Dynamic import so the PGlite/WASM dependency is loaded ONLY when local
      // mode is actually selected — it never enters the static import graph of
      // callers that stay on Postgres (e.g. the Next.js web server bundle).
      const { createPgliteGraphStore } = await import('./pglite-graph-store');
      let opened: Awaited<ReturnType<typeof createPgliteGraphStore>>;
      try {
        opened = await createPgliteGraphStore({ dataDir });
      } catch (err) {
        // Open failed — release the lock we just took so we do not strand it.
        await lock.release();
        throw err;
      }
      const { store, db, close } = opened;
      const closeWithUnlock = async (): Promise<void> => {
        try {
          await close();
        } finally {
          await lock.release();
        }
      };
      return withReadAudit({ store, db, close: closeWithUnlock }, env);
    }
    default:
      throw new Error(`unknown GRAPH_STORE='${impl}'. Supported: postgres (default), local.`);
  }
}

// Per-read audit (F10/F26) at the factory chokepoint: every runtime caller
// (CLI ingest/query/extract/retention, local desktop runtime) gets the audited
// store unless MUNIN_READ_AUDIT=false (local/free-tier users may turn it off —
// their machine, their call; managed/BYO pilots run with it on). close() drains
// the writer's buffer BEFORE the connection drops, so a short CLI run still
// lands its trail.
function withReadAudit(
  handle: { store: GraphStore; db: GraphStoreDb; close: () => Promise<void> },
  env: NodeJS.ProcessEnv,
): GraphStoreHandle {
  if (!readAuditEnabled(env)) return { ...handle, readAudit: null };
  const writer = new BatchedReadAuditWriter(handle.db);
  return {
    store: new AuditedGraphStore(handle.store, writer),
    db: handle.db,
    readAudit: writer,
    close: async () => {
      await writer.close();
      await handle.close();
    },
  };
}

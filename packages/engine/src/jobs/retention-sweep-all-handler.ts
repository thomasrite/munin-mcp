// graphile-worker job handler for `retention_sweep_all` (G2b — the recurring
// schedule G2a left open): the worker crontab fires this once
// a day, and it fans out ONE `retention_sweep` job per live tenant — keeping
// the per-tenant handler the single sweep entry point (same shape for cron,
// manual enqueue, and the local-mode CLI).
//
// Enumerates non-deleted tenants. SUSPENDED tenants are deliberately included:
// retention/TTL scrubbing is a data-protection obligation that does not pause
// when service does. Per-tenant jobs carry a jobKey so a re-fired coordinator
// (restart, manual run) replaces any still-pending sweep for a tenant instead
// of duplicating it — the sweep is idempotent anyway, this just keeps the
// queue tidy.
//
// A missed 03:00 firing (worker down) simply waits for the next day — with
// 90-day TTLs a one-day slip is immaterial, so no crontab backfill is used.

import { isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Task } from 'graphile-worker';

import { tenants } from '../db/schema';
import type { RetentionDb } from '../retention/retention-sweep';
import { JOB_RETENTION_SWEEP, JOB_RETENTION_SWEEP_ALL } from './job-types';

// Daily at 03:00 UTC (quiet hours for a UK deployment). Exported so the worker
// — and any future scheduler surface — wires the exact same line.
export const RETENTION_SWEEP_CRONTAB = `0 3 * * * ${JOB_RETENTION_SWEEP_ALL}`;

export interface RetentionSweepAllHandlerDeps {
  // The worker's raw Drizzle handle (either driver — same widening as the
  // per-tenant handler's RetentionDb).
  readonly db: RetentionDb;
}

export function makeRetentionSweepAllHandler(deps: RetentionSweepAllHandlerDeps): Task {
  // Both supported drivers expose the identical Drizzle select API — same
  // compile-time narrowing convention as PostgresGraphStore.
  const db = deps.db as PostgresJsDatabase;
  return async (_payload, helpers) => {
    const rows = await db.select({ id: tenants.id }).from(tenants).where(isNull(tenants.deletedAt));
    for (const row of rows) {
      await helpers.addJob(
        JOB_RETENTION_SWEEP,
        { tenantId: row.id },
        { jobKey: `retention_sweep:${row.id}` },
      );
    }
    // Worker lifecycle diagnostic. Routed to stderr (console.error) — same
    // convention as worker.ts: no structured logger in the engine worker library,
    // and stderr keeps stdout free for any in-process JSON-RPC (MCP) consumer.
    console.error(`retention_sweep_all enqueued ${rows.length} per-tenant sweep job(s)`);
  };
}

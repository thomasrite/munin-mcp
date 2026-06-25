// retention_sweep_all coordinator (G2b): enumerates LIVE tenants from the real
// database (in-memory PGlite — no Docker) and enqueues one per-tenant
// retention_sweep with a stable jobKey. Deleted tenants are excluded; suspended
// tenants are deliberately included (retention is a data-protection obligation
// that does not pause with service). The crontab line itself is pinned here so
// a drive-by edit to the schedule is a reviewed decision.

import type { JobHelpers } from 'graphile-worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import {
  RETENTION_SWEEP_CRONTAB,
  makeRetentionSweepAllHandler,
} from './retention-sweep-all-handler';

const LIVE_A = '00000000-0000-0000-0000-0000000000a1';
const LIVE_SUSPENDED = '00000000-0000-0000-0000-0000000000a2';
const DELETED = '00000000-0000-0000-0000-0000000000a3';

let handle: PgliteGraphStoreHandle;

beforeAll(async () => {
  handle = await createPgliteGraphStore({}); // in-memory
  await handle.db.insert(tenants).values([
    { id: LIVE_A, name: 'Live' },
    { id: LIVE_SUSPENDED, name: 'Suspended', suspendedAt: new Date() },
    { id: DELETED, name: 'Deleted', deletedAt: new Date() },
  ]);
});

afterAll(async () => {
  await handle.close();
});

describe('makeRetentionSweepAllHandler', () => {
  it('enqueues one retention_sweep per non-deleted tenant (suspended included), keyed per tenant', async () => {
    const addJob = vi.fn(async () => ({}) as never);
    const task = makeRetentionSweepAllHandler({ db: handle.db });

    await task({}, { addJob } as unknown as JobHelpers);

    expect(addJob).toHaveBeenCalledTimes(2);
    const calls = addJob.mock.calls as unknown as [
      string,
      { tenantId: string },
      { jobKey: string },
    ][];
    const byTenant = new Map(calls.map((c) => [c[1].tenantId, c]));
    expect([...byTenant.keys()].sort()).toEqual([LIVE_A, LIVE_SUSPENDED]);
    for (const [tenantId, call] of byTenant) {
      expect(call[0]).toBe('retention_sweep');
      expect(call[2]).toEqual({ jobKey: `retention_sweep:${tenantId}` });
    }
  });

  it('pins the daily schedule: 03:00 UTC, firing retention_sweep_all', () => {
    expect(RETENTION_SWEEP_CRONTAB).toBe('0 3 * * * retention_sweep_all');
  });
});

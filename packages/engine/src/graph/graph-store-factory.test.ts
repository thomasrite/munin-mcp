// loadGraphStore read-audit wiring (F10/F26).
//
// The factory is the construction chokepoint for every CLI/local runtime read
// path, so the wiring decision is proven here: default ON returns the
// AuditedGraphStore decorator, MUNIN_READ_AUDIT=false opts out (raw store,
// zero audit machinery), and close() DRAINS the buffered events before the
// connection drops — a short CLI run still lands its trail. Proven on the
// local (PGlite) backend: a durable temp data dir lets a second boot read the
// rows the first boot's close() flushed.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { auditEvents, tenants } from '../db/schema';
import { AuditedGraphStore } from './audited-graph-store';
import { loadGraphStore } from './graph-store-factory';
import { PostgresGraphStore } from './postgres-graph-store';
import { type RegularReadContext, asActorId, asDocumentId, asTenantId } from './types';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000ab');
const ACTOR = asActorId('factory-test-actor');
const CTX: RegularReadContext = {
  kind: 'regular',
  tenantId: TENANT,
  accessTags: ['t:a'],
  actor: ACTOR,
};

describe('loadGraphStore read-audit wiring (F10/F26)', () => {
  it('MUNIN_READ_AUDIT=false opts out: the raw store, no decorator', async () => {
    const handle = await loadGraphStore({
      GRAPH_STORE: 'local',
      PGLITE_DATA_DIR: 'memory://',
      MUNIN_READ_AUDIT: 'false',
    });
    try {
      expect(handle.store).toBeInstanceOf(PostgresGraphStore);
    } finally {
      await handle.close();
    }
  });

  it('default ON: audited store, and close() drains the buffer into the trail', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'munin-read-audit-'));
    const env = { GRAPH_STORE: 'local', PGLITE_DATA_DIR: dataDir };
    try {
      const first = await loadGraphStore(env);
      expect(first.store).toBeInstanceOf(AuditedGraphStore);
      await first.db.insert(tenants).values({ id: TENANT, name: 'T' });
      // One regular read — buffered, NOT yet flushed (default thresholds).
      await first.store.getDocument(CTX, asDocumentId('00000000-0000-0000-0000-00000000dead'));
      await first.close(); // must drain before the connection drops

      // A second boot over the same data dir sees the flushed row.
      const second = await loadGraphStore(env);
      try {
        const rows = await second.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, TENANT));
        const readRows = rows.filter((r) => r.action === 'read.getDocument');
        expect(readRows).toHaveLength(1);
        expect(readRows[0]).toMatchObject({
          actor: ACTOR,
          targetKind: 'document',
          details: { resultCount: 0 },
        });
        expect(readRows[0]?.accessTagsUsed).toEqual(['t:a']);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

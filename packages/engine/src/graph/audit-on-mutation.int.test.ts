// Integration tests for audit-on-mutation (P6a) against REAL Postgres.
//
// Every shared-graph mutation (updateEntity / updateEdge) writes ONE audit_events
// row in the SAME transaction as the mutation (mirroring internal_bypass_log):
//   - exactly one row, with the actor, target, access tags used, and a
//     CONTENT-FREE change summary (changed field NAMES, never values/PII)
//   - a rolled-back mutation writes NO audit row (the in-transaction guarantee)

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { auditEvents, tenants } from '../db/schema';

import { PostgresGraphStore } from './postgres-graph-store';
import {
  type EdgeId,
  type EntityId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asEntityId,
  asTenantId,
  internalBypass,
} from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const STEWARD = asActorId('steward-oid');
const TAGS = ['t:hr'];

const writeCtx = (tenantId: TenantId, actor = STEWARD): WriteContext => ({ tenantId, actor });
const bypassCtx = (tenantId: TenantId): ReadContext => ({
  kind: 'bypass',
  tenantId,
  bypass: internalBypass('audit-on-mutation.test', 'test reads the mutated row back'),
  actor: STEWARD,
});

async function auditRows() {
  return db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT_A));
}

// Two entities + an edge to mutate.
async function seedGraph(): Promise<{ a: EntityId; b: EntityId; edge: EdgeId }> {
  const ctx = writeCtx(TENANT_A);
  const a = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'original-a' },
      accessTags: TAGS,
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;
  const b = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'original-b' },
      accessTags: TAGS,
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;
  const edge = (
    await store.insertEdge(ctx, {
      type: 'related',
      fromEntityId: a,
      toEntityId: b,
      accessTags: TAGS,
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;
  return { a, b, edge };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values([{ id: TENANT_A, name: 'A' }]);
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

afterEach(async () => {
  await db.execute(sql`TRUNCATE entities, edges, audit_events RESTART IDENTITY CASCADE`);
});

describe('audit-on-mutation — every shared-graph mutation is audited', () => {
  it('updateEntity writes exactly one audit_events row with a content-free change summary', async () => {
    const { a } = await seedGraph();
    await store.updateEntity(writeCtx(TENANT_A), a, {
      properties: { name: 'corrected' },
      accessTags: ['t:hr', 't:extra'],
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe('update_entity');
    expect(row.targetKind).toBe('entity');
    expect(row.targetId).toBe(a);
    expect(row.actor).toBe(STEWARD);
    // accessTagsUsed reflects the resulting row's tags.
    expect([...row.accessTagsUsed].sort()).toEqual(['t:extra', 't:hr']);
    // The change summary lists the field NAMES that changed — and nothing else.
    expect(row.details).toEqual({ changedFields: ['properties', 'accessTags'] });
  });

  it('updateEdge writes exactly one audit_events row', async () => {
    const { edge } = await seedGraph();
    await store.updateEdge(writeCtx(TENANT_A), edge, { confidence: 0.5 });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('update_edge');
    expect(rows[0]!.targetKind).toBe('edge');
    expect(rows[0]!.targetId).toBe(edge);
    expect(rows[0]!.details).toEqual({ changedFields: ['confidence'] });
  });

  it('the audit details carry only the changed field NAMES, never values', async () => {
    const { a } = await seedGraph();
    await store.updateEntity(writeCtx(TENANT_A), a, {
      properties: { name: 'super-secret-corrected-value' },
    });
    const rows = await auditRows();
    // The serialised details must NOT contain the new property value anywhere.
    expect(JSON.stringify(rows[0]!.details)).not.toContain('super-secret-corrected-value');
    expect(rows[0]!.details).toEqual({ changedFields: ['properties'] });
  });

  it('a rolled-back updateEntity writes NO audit row (in-tx guarantee), and the entity is unchanged', async () => {
    const { a } = await seedGraph();
    await expect(
      store.withTransaction(writeCtx(TENANT_A), async (tx) => {
        await tx.updateEntity(writeCtx(TENANT_A), a, { properties: { name: 'corrected' } });
        // The mutation + its audit row are now staged in this transaction…
        throw new Error('boom'); // …and this rolls back BOTH.
      }),
    ).rejects.toThrow('boom');

    // No audit row survived the rollback.
    expect(await auditRows()).toHaveLength(0);
    // …and the entity itself is untouched.
    const entity = await store.getEntity(bypassCtx(TENANT_A), a);
    expect(entity?.properties).toEqual({ name: 'original-a' });
  });

  it('updating a non-existent entity throws and writes no audit row', async () => {
    await seedGraph();
    const missing = asEntityId('11111111-1111-1111-1111-111111111111');
    await expect(
      store.updateEntity(writeCtx(TENANT_A), missing, { properties: { name: 'nope' } }),
    ).rejects.toThrow();
    expect(await auditRows()).toHaveLength(0);
  });

  // recordAuditEvent — the generic public audit write for actions with no
  // dedicated mutation method (P5b: approving a learned-rule promotion).
  it('recordAuditEvent writes exactly one row with the supplied action/target/details', async () => {
    const ruleId = '22222222-2222-2222-2222-222222222222';
    await store.recordAuditEvent(writeCtx(TENANT_A), {
      action: 'approve_rule_promotion',
      targetKind: 'learned_rule',
      targetId: ruleId,
      accessTagsUsed: TAGS,
      details: { reviewItemId: 'r1', ruleKey: 'tone:concise', reinforced: false },
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe('approve_rule_promotion');
    expect(row.targetKind).toBe('learned_rule');
    expect(row.targetId).toBe(ruleId);
    expect([...row.accessTagsUsed]).toEqual(TAGS);
    expect(row.details).toEqual({ reviewItemId: 'r1', ruleKey: 'tone:concise', reinforced: false });
  });

  it('recordAuditEvent inside a rolled-back transaction writes NO row (in-tx guarantee)', async () => {
    await expect(
      store.withTransaction(writeCtx(TENANT_A), async (tx) => {
        await tx.recordAuditEvent(writeCtx(TENANT_A), {
          action: 'approve_rule_promotion',
          targetKind: 'learned_rule',
          targetId: '33333333-3333-3333-3333-333333333333',
          accessTagsUsed: [],
          details: {},
        });
        throw new Error('boom'); // rolls the audit row back with the rest of the tx
      }),
    ).rejects.toThrow('boom');
    expect(await auditRows()).toHaveLength(0);
  });
});

// Integration tests for the review-queue store (P6a) against REAL Postgres.
//
// The ACCESS-GATED read no-leak proof lives in the P0 permission matrix
// (permissions/permission-matrix.int.test.ts). This file proves the STORE
// SEMANTICS the governance workflow rests on:
//   - the GOLDEN RULE: a suggestion enters the queue 'pending' with ZERO shared
//     effect (the target entity is never mutated by enqueue OR resolve — applying
//     an approved correction is updateEntity/updateEdge, the caller's job)
//   - resolve flips a still-pending item to its terminal state and is idempotent
//     against double-resolution + tenant-scoped
//   - the queue is GENERIC: an arbitrary target_kind round-trips, proving the
//     learning loop can reuse this one queue without a schema change

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';

import { NotFoundError } from './errors';
import { PostgresGraphStore } from './postgres-graph-store';
import {
  type EntityId,
  type ReadContext,
  type ReviewItemId,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  internalBypass,
} from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000bb');
const ACTOR = asActorId('suggester');
const STEWARD = asActorId('steward');
const TAGS = ['t:hr'];

const writeCtx = (tenantId: TenantId, actor = ACTOR): WriteContext => ({ tenantId, actor });
const readCtx = (tenantId: TenantId, accessTags: readonly string[]): ReadContext => ({
  kind: 'regular',
  tenantId,
  accessTags,
  actor: ACTOR,
});
const bypassCtx = (tenantId: TenantId): ReadContext => ({
  kind: 'bypass',
  tenantId,
  bypass: internalBypass('review-queue.test', 'test reads full queue'),
  actor: ACTOR,
});

// Insert a real entity to be the correction TARGET, so the golden-rule test can
// assert it is never mutated by the queue.
async function seedEntity(tenantId: TenantId): Promise<EntityId> {
  return (
    await store.insertEntity(writeCtx(tenantId), {
      type: 'Thing',
      properties: { name: 'original' },
      accessTags: TAGS,
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'A' },
    { id: TENANT_B, name: 'B' },
  ]);
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

afterEach(async () => {
  await db.execute(sql`TRUNCATE review_queue, entities RESTART IDENTITY CASCADE`);
});

describe('enqueueReviewItem — the golden rule: a suggestion has ZERO shared effect', () => {
  it('lands a pending item and does NOT mutate the target entity', async () => {
    const entityId = await seedEntity(TENANT_A);
    const item = await store.enqueueReviewItem(writeCtx(TENANT_A), {
      targetKind: 'entity',
      targetId: entityId,
      proposedChange: { patch: { properties: { name: 'corrected' } } },
      accessTags: TAGS,
      note: 'name is wrong',
    });

    expect(item.status).toBe('pending');
    expect(item.proposedBy).toBe(ACTOR);
    expect(item.reviewedBy).toBeNull();
    expect(item.reviewedAt).toBeNull();
    expect(item.note).toBe('name is wrong');

    // The shared graph is UNTOUCHED — the correction is only a suggestion.
    const entity = await store.getEntity(bypassCtx(TENANT_A), entityId);
    expect(entity?.properties).toEqual({ name: 'original' });
  });

  it('the pending item is visible to a caller with the target tags', async () => {
    const entityId = await seedEntity(TENANT_A);
    await store.enqueueReviewItem(writeCtx(TENANT_A), {
      targetKind: 'entity',
      targetId: entityId,
      proposedChange: {},
      accessTags: TAGS,
    });
    const items = await store.findPendingReviewItems(readCtx(TENANT_A, TAGS));
    expect(items).toHaveLength(1);
  });
});

describe('resolveReviewItem — flips status without applying the change', () => {
  async function enqueue(tenantId: TenantId): Promise<ReviewItemId> {
    const entityId = await seedEntity(tenantId);
    return (
      await store.enqueueReviewItem(writeCtx(tenantId), {
        targetKind: 'entity',
        targetId: entityId,
        proposedChange: { patch: { properties: { name: 'corrected' } } },
        accessTags: TAGS,
      })
    ).id;
  }

  it('approve sets status/reviewedBy/reviewedAt and drops it from the pending list', async () => {
    const id = await enqueue(TENANT_A);
    const resolved = await store.resolveReviewItem(writeCtx(TENANT_A, STEWARD), id, {
      decision: 'approved',
    });
    expect(resolved.status).toBe('approved');
    expect(resolved.reviewedBy).toBe(STEWARD);
    expect(resolved.reviewedAt).not.toBeNull();
    expect(await store.findPendingReviewItems(readCtx(TENANT_A, TAGS))).toEqual([]);
  });

  it('reject sets status rejected and changes nothing else; the item leaves the pending list', async () => {
    const id = await enqueue(TENANT_A);
    const resolved = await store.resolveReviewItem(writeCtx(TENANT_A, STEWARD), id, {
      decision: 'rejected',
    });
    expect(resolved.status).toBe('rejected');
    expect(await store.findPendingReviewItems(readCtx(TENANT_A, TAGS))).toEqual([]);
  });

  it('re-resolving an already-resolved item throws NotFound (an approval can never be flipped)', async () => {
    const id = await enqueue(TENANT_A);
    await store.resolveReviewItem(writeCtx(TENANT_A, STEWARD), id, { decision: 'approved' });
    await expect(
      store.resolveReviewItem(writeCtx(TENANT_A, STEWARD), id, { decision: 'rejected' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('resolving from the WRONG tenant throws NotFound (tenant isolation on the write)', async () => {
    const id = await enqueue(TENANT_A);
    await expect(
      store.resolveReviewItem(writeCtx(TENANT_B, STEWARD), id, { decision: 'approved' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // …and the item is still pending in its own tenant.
    expect(await store.findPendingReviewItems(readCtx(TENANT_A, TAGS))).toHaveLength(1);
  });
});

describe('generic queue — an arbitrary target_kind proves the learning loop can reuse it', () => {
  it('accepts a non-entity/edge target_kind with a null target_id and opaque payload', async () => {
    const item = await store.enqueueReviewItem(writeCtx(TENANT_A), {
      // The learning loop's kind — the engine never interprets it, so NO schema
      // change is needed for P5 to reuse this same queue.
      targetKind: 'learned_rule',
      targetId: null,
      proposedChange: { rule: { boost: ['priority'], weight: 1.5 } },
      accessTags: TAGS,
    });
    expect(item.targetKind).toBe('learned_rule');
    expect(item.targetId).toBeNull();

    const fetched = await store.getReviewItem(readCtx(TENANT_A, TAGS), item.id);
    expect(fetched?.targetKind).toBe('learned_rule');
    expect(fetched?.proposedChange).toEqual({ rule: { boost: ['priority'], weight: 1.5 } });
    // It shows up in the same pending queue alongside entity/edge corrections.
    expect(await store.findPendingReviewItems(readCtx(TENANT_A, TAGS))).toHaveLength(1);
  });
});

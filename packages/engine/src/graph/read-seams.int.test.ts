// Integration tests for the four read-only engine seams the web screens need:
//   1. getGraphStats           — entity-by-type counts + edge total (Mind overview)
//   2. listAuditEvents         — tenant audit trail (Data activity / access-audit)
//   3. listLlmCalls /          — per-call feed + on-device/cloud egress summary
//      summariseLlmCalls          (receipts screen)
//   4. countCitationsByDocument — per-document citation rollup (Library "cited N×")
//
// Real Postgres via testcontainers (no mocked DB). The emphasis is
// PERMISSION-CORRECTNESS: every content-backed reader (getGraphStats,
// countCitationsByDocument) is proven tenant-scoped, access-tag filtered, and
// fail-closed on an empty tag set — a caller without the tenant/tag sees NOTHING.
// The content-free telemetry readers (listAuditEvents, listLlmCalls,
// summariseLlmCalls) are proven tenant-scoped (their tables carry no access_tags
// column — they record access/cost, they are not access-gated content).

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { auditEvents, llmCalls, tenants } from '../db/schema';

import { PostgresGraphStore } from './postgres-graph-store';
import {
  type DocumentId,
  type EntityId,
  type ExtractorVersionId,
  type ParagraphId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asExtractorVersionId,
  asParagraphId,
  asTenantId,
} from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000a0a0a');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000b0b0b');
const ACTOR = asActorId('actor-1');
const ACTOR_2 = asActorId('actor-2');

const HR = 't:hr';
const LOCKED = 't:locked';

// Per-tenant document/paragraph/extractor fixtures, recreated each test.
let docHr: DocumentId; // tags [HR]
let paraHr: ParagraphId;
let docLocked: DocumentId; // tags [LOCKED]
let paraLocked: ParagraphId;
let extA: ExtractorVersionId;
let docB: DocumentId; // tenant B, tags [HR]
let paraB: ParagraphId;
let extB: ExtractorVersionId;

const readCtx = (
  tenantId: TenantId,
  accessTags: readonly string[],
  actor = ACTOR,
): ReadContext => ({
  kind: 'regular',
  tenantId,
  accessTags,
  actor,
});
const writeCtx = (tenantId: TenantId, actor = ACTOR): WriteContext => ({ tenantId, actor });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Tenant A' },
    { id: TENANT_B, name: 'Tenant B' },
  ]);
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents,
    extractor_versions, audit_events, llm_calls, citation_events, connector_state
    RESTART IDENTITY CASCADE`);

  docHr = asDocumentId(crypto.randomUUID());
  paraHr = asParagraphId(crypto.randomUUID());
  docLocked = asDocumentId(crypto.randomUUID());
  paraLocked = asParagraphId(crypto.randomUUID());
  extA = asExtractorVersionId(crypto.randomUUID());
  docB = asDocumentId(crypto.randomUUID());
  paraB = asParagraphId(crypto.randomUUID());
  extB = asExtractorVersionId(crypto.randomUUID());

  const ctxA = writeCtx(TENANT_A);
  await store.insertDocument(ctxA, {
    id: docHr,
    title: 'HR Doc',
    blobStorageUri: 'blob://hr',
    accessTags: [HR],
  });
  await store.insertParagraphsBulk(ctxA, [
    { id: paraHr, documentId: docHr, paragraphIndex: 0, text: 'hr para', accessTags: [HR] },
  ]);
  await store.insertDocument(ctxA, {
    id: docLocked,
    title: 'Locked Doc',
    blobStorageUri: 'blob://locked',
    accessTags: [LOCKED],
  });
  await store.insertParagraphsBulk(ctxA, [
    {
      id: paraLocked,
      documentId: docLocked,
      paragraphIndex: 0,
      text: 'locked para',
      accessTags: [LOCKED],
    },
  ]);
  await store.upsertExtractorVersion(ctxA, {
    id: extA,
    configurationId: 'cfg',
    configurationVersion: '0.1.0',
    schemaHash: 'h-a',
    promptHash: 'p-a',
    modelId: 'm-a',
  });

  const ctxB = writeCtx(TENANT_B);
  await store.insertDocument(ctxB, {
    id: docB,
    title: 'B Doc',
    blobStorageUri: 'blob://b',
    accessTags: [HR],
  });
  await store.insertParagraphsBulk(ctxB, [
    { id: paraB, documentId: docB, paragraphIndex: 0, text: 'b para', accessTags: [HR] },
  ]);
  await store.upsertExtractorVersion(ctxB, {
    id: extB,
    configurationId: 'cfg',
    configurationVersion: '0.1.0',
    schemaHash: 'h-b',
    promptHash: 'p-b',
    modelId: 'm-b',
  });
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function seedEntity(
  ctx: WriteContext,
  type: string,
  tags: readonly string[],
  doc: DocumentId,
  para: ParagraphId,
  ext: ExtractorVersionId,
): Promise<EntityId> {
  const e = await store.insertEntity(ctx, {
    type,
    properties: { name: `n-${crypto.randomUUID().slice(0, 6)}` },
    accessTags: tags,
    provenance: {
      kind: 'document_extract',
      documentId: doc,
      paragraphId: para,
      extractorVersionId: ext,
      confidence: 0.9,
    },
  });
  return e.id;
}

async function seedEdge(
  ctx: WriteContext,
  type: string,
  from: EntityId,
  to: EntityId,
  tags: readonly string[],
  doc: DocumentId,
  para: ParagraphId,
  ext: ExtractorVersionId,
): Promise<void> {
  await store.insertEdge(ctx, {
    type,
    fromEntityId: from,
    toEntityId: to,
    accessTags: tags,
    provenance: {
      kind: 'document_extract',
      documentId: doc,
      paragraphId: para,
      extractorVersionId: ext,
      confidence: 0.9,
    },
  });
}

async function seedAudit(
  tenantId: TenantId,
  actor: string,
  action: string,
  occurredAt: Date,
  targetId: string | null = null,
): Promise<void> {
  await db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    tenantId,
    actor,
    action,
    targetKind: 'entity',
    targetId,
    accessTagsUsed: [HR],
    details: {},
    occurredAt,
  });
}

async function seedLlmCall(opts: {
  tenantId: TenantId;
  purpose: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
  region: string;
  costPence: number | null;
  occurredAt: Date;
}): Promise<void> {
  await db.insert(llmCalls).values({
    id: crypto.randomUUID(),
    tenantId: opts.tenantId,
    purpose: opts.purpose,
    modelId: 'test-model',
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    costEstimatePence: opts.costPence === null ? null : BigInt(opts.costPence),
    latencyMs: 1,
    region: opts.region,
    metadata: {},
    occurredAt: opts.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// 1. getGraphStats
// ---------------------------------------------------------------------------

describe('getGraphStats', () => {
  beforeEach(async () => {
    const ctxA = writeCtx(TENANT_A);
    const ctxB = writeCtx(TENANT_B);
    // Entities under HR: 2 Person + 1 Project (the counted types, deliberately
    // edge-free so an entity soft-delete cannot cascade into the edge totals);
    // 2 Node under HR are the HR edge endpoints. 2 Secret only under LOCKED.
    await seedEntity(ctxA, 'Person', [HR], docHr, paraHr, extA);
    await seedEntity(ctxA, 'Person', [HR], docHr, paraHr, extA);
    await seedEntity(ctxA, 'Project', [HR], docHr, paraHr, extA);
    const n1 = await seedEntity(ctxA, 'Node', [HR], docHr, paraHr, extA);
    const n2 = await seedEntity(ctxA, 'Node', [HR], docHr, paraHr, extA);
    const s1 = await seedEntity(ctxA, 'Secret', [LOCKED], docLocked, paraLocked, extA);
    const s2 = await seedEntity(ctxA, 'Secret', [LOCKED], docLocked, paraLocked, extA);
    // Tenant B entities that must never count for tenant A.
    const b1 = await seedEntity(ctxB, 'Person', [HR], docB, paraB, extB);
    const b2 = await seedEntity(ctxB, 'Person', [HR], docB, paraB, extB);
    // Edges with CONTRASTING tenant/tag so the edge-total filter is testable:
    // 2 HR edges (TENANT_A), 1 LOCKED edge (TENANT_A), 1 HR edge (TENANT_B).
    await seedEdge(ctxA, 'rel', n1, n2, [HR], docHr, paraHr, extA);
    await seedEdge(ctxA, 'rel', n2, n1, [HR], docHr, paraHr, extA);
    await seedEdge(ctxA, 'rel', s1, s2, [LOCKED], docLocked, paraLocked, extA);
    await seedEdge(ctxB, 'rel', b1, b2, [HR], docB, paraB, extB);
  });

  it('groups visible entities by type (count desc) and totals ONLY visible edges', async () => {
    const stats = await store.getGraphStats(readCtx(TENANT_A, [HR]));

    const map = new Map(stats.entitiesByType.map((r) => [r.type, r.count]));
    expect(map.get('Person')).toBe(2);
    expect(map.get('Project')).toBe(1);
    expect(map.get('Node')).toBe(2);
    expect(map.has('Secret')).toBe(false); // LOCKED-only, invisible to the HR caller
    expect(stats.totalEntities).toBe(5); // 2 Person + 1 Project + 2 Node
    // Only the 2 HR/TENANT_A edges — the LOCKED edge and the TENANT_B edge are excluded.
    expect(stats.totalEdges).toBe(2);
    // Ordering: counts are non-increasing.
    const counts = stats.entitiesByType.map((r) => r.count);
    expect([...counts]).toEqual([...counts].sort((x, y) => y - x));
  });

  it('PERMISSION: a non-overlapping tag sees only its own types AND edges (LOCKED)', async () => {
    const stats = await store.getGraphStats(readCtx(TENANT_A, [LOCKED]));
    const map = new Map(stats.entitiesByType.map((r) => [r.type, r.count]));
    expect(map.get('Secret')).toBe(2);
    expect(map.has('Person')).toBe(false);
    expect(map.has('Project')).toBe(false);
    expect(map.has('Node')).toBe(false);
    expect(stats.totalEntities).toBe(2);
    // Only the single LOCKED edge — the HR edges are invisible to the LOCKED caller.
    expect(stats.totalEdges).toBe(1);
  });

  it('PERMISSION: empty caller tag set is fail-closed (entities AND edges zero)', async () => {
    const stats = await store.getGraphStats(readCtx(TENANT_A, []));
    expect(stats.entitiesByType).toEqual([]);
    expect(stats.totalEntities).toBe(0);
    expect(stats.totalEdges).toBe(0);
  });

  it('PERMISSION: tenant isolation — tenant B sees only its own entities AND edges', async () => {
    const stats = await store.getGraphStats(readCtx(TENANT_B, [HR]));
    const map = new Map(stats.entitiesByType.map((r) => [r.type, r.count]));
    expect(map.get('Person')).toBe(2); // B's two People, not A's
    expect(stats.totalEntities).toBe(2);
    expect(stats.totalEdges).toBe(1); // B's single edge, not A's two
  });

  it('excludes soft-deleted entities AND edges from the counts', async () => {
    const before = await store.getGraphStats(readCtx(TENANT_A, [HR]));
    expect(before.entitiesByType.find((r) => r.type === 'Person')?.count).toBe(2);
    expect(before.totalEdges).toBe(2);

    // Soft-delete an edge-free Person (no incident-edge cascade) and one HR edge.
    const people = await store.findEntities(readCtx(TENANT_A, [HR]), { types: ['Person'] });
    await store.softDeleteEntity(writeCtx(TENANT_A), people.items[0]!.id);
    const hrEdges = await store.findEdges(readCtx(TENANT_A, [HR]), {});
    await store.softDeleteEdge(writeCtx(TENANT_A), hrEdges.items[0]!.id);

    const after = await store.getGraphStats(readCtx(TENANT_A, [HR]));
    expect(after.entitiesByType.find((r) => r.type === 'Person')?.count).toBe(1);
    expect(after.totalEdges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. listAuditEvents
// ---------------------------------------------------------------------------

describe('listAuditEvents', () => {
  it('returns the tenant trail newest-first, content-free, respecting limit', async () => {
    await seedAudit(TENANT_A, ACTOR, 'read.getEntity', new Date('2026-01-01T00:00:00Z'));
    await seedAudit(TENANT_A, ACTOR, 'read.findEntities', new Date('2026-01-02T00:00:00Z'));
    await seedAudit(TENANT_A, ACTOR_2, 'update.entity', new Date('2026-01-03T00:00:00Z'));

    const rows = await store.listAuditEvents(readCtx(TENANT_A, [HR]));
    expect(rows.map((r) => r.action)).toEqual([
      'update.entity',
      'read.findEntities',
      'read.getEntity',
    ]);
    // Content-free shape: only accountability fields are present.
    expect(rows[0]).toMatchObject({
      actor: ACTOR_2,
      action: 'update.entity',
      targetKind: 'entity',
    });
    // The free-form `details` jsonb is NOT projected (structural content-freedom),
    // so it can never leak whatever a writer put in it.
    expect(rows[0]).not.toHaveProperty('details');

    const limited = await store.listAuditEvents(readCtx(TENANT_A, [HR]), { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.action).toBe('update.entity');
  });

  it('honours the since lower-bound (inclusive)', async () => {
    await seedAudit(TENANT_A, ACTOR, 'old', new Date('2026-01-01T00:00:00Z'));
    await seedAudit(TENANT_A, ACTOR, 'boundary', new Date('2026-01-05T00:00:00Z'));
    await seedAudit(TENANT_A, ACTOR, 'new', new Date('2026-01-10T00:00:00Z'));

    const rows = await store.listAuditEvents(readCtx(TENANT_A, [HR]), {
      since: new Date('2026-01-05T00:00:00Z'),
    });
    expect(rows.map((r) => r.action).sort()).toEqual(['boundary', 'new']);
  });

  it('PERMISSION: tenant isolation — tenant A never sees tenant B audit rows', async () => {
    await seedAudit(TENANT_A, ACTOR, 'a-action', new Date('2026-01-01T00:00:00Z'));
    await seedAudit(TENANT_B, ACTOR, 'b-action', new Date('2026-01-02T00:00:00Z'));

    const aRows = await store.listAuditEvents(readCtx(TENANT_A, [HR]));
    expect(aRows.map((r) => r.action)).toEqual(['a-action']);
    const bRows = await store.listAuditEvents(readCtx(TENANT_B, [HR]));
    expect(bRows.map((r) => r.action)).toEqual(['b-action']);
  });

  it('is tenant-scoped, not access-tag-gated — an empty tag set still sees the trail', async () => {
    // audit_events has no access_tags column; it records access, it is not gated
    // content. The reader must NOT fail-close on an empty caller tag set (unlike
    // the content readers) — an access-audit page must show all access.
    await seedAudit(TENANT_A, ACTOR, 'recorded', new Date('2026-01-01T00:00:00Z'));
    const rows = await store.listAuditEvents(readCtx(TENANT_A, []));
    expect(rows.map((r) => r.action)).toEqual(['recorded']);
  });
});

// ---------------------------------------------------------------------------
// 3. listLlmCalls + summariseLlmCalls
// ---------------------------------------------------------------------------

describe('listLlmCalls', () => {
  it('returns the tenant feed newest-first with location classification', async () => {
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'embedding',
      region: 'local',
      costPence: null,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'query',
      region: 'eu-west-2',
      costPence: 42,
      occurredAt: new Date('2026-01-02T00:00:00Z'),
    });

    const rows = await store.listLlmCalls(readCtx(TENANT_A, [HR]));
    expect(rows.map((r) => r.region)).toEqual(['eu-west-2', 'local']); // newest first
    expect(rows[0]).toMatchObject({
      purpose: 'query',
      region: 'eu-west-2',
      location: 'cloud',
      costEstimatePence: 42,
    });
    expect(rows[1]).toMatchObject({
      region: 'local',
      location: 'on_device',
      costEstimatePence: null,
    });
  });

  it('filters by purpose and limit', async () => {
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'extraction',
      region: 'local',
      costPence: 1,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'query',
      region: 'local',
      costPence: 1,
      occurredAt: new Date('2026-01-02T00:00:00Z'),
    });

    const onlyQuery = await store.listLlmCalls(readCtx(TENANT_A, [HR]), { purpose: 'query' });
    expect(onlyQuery).toHaveLength(1);
    expect(onlyQuery[0]?.purpose).toBe('query');

    const limited = await store.listLlmCalls(readCtx(TENANT_A, [HR]), { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('PERMISSION: tenant isolation — tenant A never sees tenant B calls', async () => {
    await seedLlmCall({
      tenantId: TENANT_B,
      purpose: 'query',
      region: 'eu-west-2',
      costPence: 99,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    });
    const rows = await store.listLlmCalls(readCtx(TENANT_A, [HR]));
    expect(rows).toHaveLength(0);
  });
});

describe('summariseLlmCalls', () => {
  beforeEach(async () => {
    // Tenant A: 2 local (on-device), 1 eu-west-2 (cloud), 1 stub.
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'embedding',
      region: 'local',
      costPence: null,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'query',
      region: 'local',
      costPence: 10,
      occurredAt: new Date('2026-01-02T00:00:00Z'),
    });
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'query',
      region: 'eu-west-2',
      costPence: 30,
      occurredAt: new Date('2026-01-03T00:00:00Z'),
    });
    await seedLlmCall({
      tenantId: TENANT_A,
      purpose: 'extraction',
      region: 'stub',
      costPence: 0,
      occurredAt: new Date('2026-01-04T00:00:00Z'),
    });
    // Tenant B noise that must not bleed into A's summary.
    await seedLlmCall({
      tenantId: TENANT_B,
      purpose: 'query',
      region: 'eu-west-2',
      costPence: 500,
      occurredAt: new Date('2026-01-05T00:00:00Z'),
    });
  });

  it('rolls up per-region with on-device/cloud/stub buckets and summed cost', async () => {
    const s = await store.summariseLlmCalls(readCtx(TENANT_A, [HR]));

    const byRegion = new Map(s.byRegion.map((r) => [r.region, r]));
    expect(byRegion.get('local')).toMatchObject({
      calls: 2,
      location: 'on_device',
      costEstimatePence: 10, // null + 10
    });
    expect(byRegion.get('eu-west-2')).toMatchObject({
      calls: 1,
      location: 'cloud',
      costEstimatePence: 30,
    });
    expect(byRegion.get('stub')).toMatchObject({
      calls: 1,
      location: 'stub',
      costEstimatePence: 0,
    });

    expect(s.onDevice).toEqual({ calls: 2, costEstimatePence: 10 });
    expect(s.cloud).toEqual({ calls: 1, costEstimatePence: 30 });
    expect(s.stub).toEqual({ calls: 1, costEstimatePence: 0 });
    expect(s.totalCalls).toBe(4); // tenant B's call excluded
    expect(s.totalCostEstimatePence).toBe(40);
  });

  it('honours the since lower-bound', async () => {
    const s = await store.summariseLlmCalls(readCtx(TENANT_A, [HR]), {
      since: new Date('2026-01-03T00:00:00Z'),
    });
    // Only the eu-west-2 (30) and stub (0) calls are at/after the boundary.
    expect(s.totalCalls).toBe(2);
    expect(s.cloud).toEqual({ calls: 1, costEstimatePence: 30 });
    expect(s.onDevice).toEqual({ calls: 0, costEstimatePence: 0 });
  });

  it('PERMISSION: tenant isolation — empty summary for a tenant with no calls', async () => {
    await db.execute(sql`DELETE FROM llm_calls WHERE tenant_id = ${TENANT_A}`);
    const s = await store.summariseLlmCalls(readCtx(TENANT_A, [HR]));
    expect(s.totalCalls).toBe(0);
    expect(s.byRegion).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. countCitationsByDocument
// ---------------------------------------------------------------------------

describe('countCitationsByDocument', () => {
  beforeEach(async () => {
    const ctxA = writeCtx(TENANT_A);
    // 3 citations on the HR doc, 2 on the LOCKED doc.
    await store.insertCitationEvents(ctxA, [
      { paragraphId: paraHr, documentId: docHr },
      { paragraphId: paraHr, documentId: docHr },
      { paragraphId: paraHr, documentId: docHr },
      { paragraphId: paraLocked, documentId: docLocked },
      { paragraphId: paraLocked, documentId: docLocked },
    ]);
    // Tenant B citation that must never count for tenant A.
    await store.insertCitationEvents(writeCtx(TENANT_B), [
      { paragraphId: paraB, documentId: docB },
    ]);
  });

  it('counts citations per visible document within the tenant', async () => {
    const counts = await store.countCitationsByDocument(readCtx(TENANT_A, [HR, LOCKED]), [
      docHr,
      docLocked,
    ]);
    expect(counts.get(docHr)).toBe(3);
    expect(counts.get(docLocked)).toBe(2);
  });

  it('empty input returns an empty map', async () => {
    const counts = await store.countCitationsByDocument(readCtx(TENANT_A, [HR]), []);
    expect(counts.size).toBe(0);
  });

  it('PERMISSION: a document the caller cannot see yields no entry (despite citations existing)', async () => {
    // Caller holds HR only — the LOCKED doc and its 2 citations must stay invisible.
    const counts = await store.countCitationsByDocument(readCtx(TENANT_A, [HR]), [
      docHr,
      docLocked,
    ]);
    expect(counts.get(docHr)).toBe(3);
    expect(counts.has(docLocked)).toBe(false);
  });

  it('PERMISSION: empty caller tag set is fail-closed (no counts at all)', async () => {
    const counts = await store.countCitationsByDocument(readCtx(TENANT_A, []), [docHr, docLocked]);
    expect(counts.size).toBe(0);
  });

  it('PERMISSION: tenant isolation — a cross-tenant document id is never counted', async () => {
    // Tenant A asks about tenant B's document id: not visible, no entry — even
    // though a citation row for docB exists in tenant B.
    const counts = await store.countCitationsByDocument(readCtx(TENANT_A, [HR]), [docHr, docB]);
    expect(counts.get(docHr)).toBe(3);
    expect(counts.has(docB)).toBe(false);
  });
});

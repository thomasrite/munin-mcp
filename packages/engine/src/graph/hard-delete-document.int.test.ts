// Integration tests for hardDeleteDocument (P6b) against REAL Postgres.
//
// The DB half of right-to-erasure. Proves INVARIANT 1 (zero orphans + complete
// erasure) at the row level, plus the in-transaction audit + bypass-log records
// and tenant isolation. (The blob delete + verified-gone receipt is the
// orchestrator's job — eraseDocument, tested separately.)
//
// Zero-orphans is the headline: the SET NULL rows (entities/edges via
// source_document_id) and the polymorphic embeddings (no FK) MUST be deleted
// explicitly — a naive `DELETE documents` would leave them content-intact. The
// test seeds every derived row type, erases, and asserts each is GONE for the
// target document AND that no entity/edge was merely null-ed (orphaned).

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import {
  auditEvents,
  citationEvents,
  documentDuplicates,
  edges,
  embeddings,
  entities,
  internalBypassLog,
  reviewQueue,
  tenants,
} from '../db/schema';

import { NotFoundError } from './errors';
import { PostgresGraphStore } from './postgres-graph-store';
import {
  type DocumentId,
  type EntityId,
  type ParagraphId,
  type ReadContext,
  type TenantId,
  asActorId,
  asDocumentId,
  asReviewItemId,
  asTenantId,
  internalBypass,
} from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000bb');
const ACTOR = asActorId('dpo-oid');
const MODEL = 'erase-model';
const TAGS = ['t:hr'];

const writeCtx = (tenantId: TenantId) => ({ tenantId, actor: ACTOR });
const bypassCtx = (tenantId: TenantId): ReadContext => ({
  kind: 'bypass',
  tenantId,
  bypass: internalBypass(
    'hard-delete-document.test',
    'test reads the full graph to assert erasure',
  ),
  actor: ACTOR,
});

function vec(seed: number): number[] {
  const v = new Array<number>(1024);
  for (let i = 0; i < 1024; i++) v[i] = ((seed + i) % 7) / 7 + 0.01;
  return v;
}

interface Seeded {
  doc: DocumentId;
  paraIds: ParagraphId[];
  entityIds: EntityId[];
  edgeId: string;
  // the unrelated counterpart that must SURVIVE erasure
  other: DocumentId;
  otherEntityId: EntityId;
  otherParaId: ParagraphId;
  // review items (F54): the two pending items targeting erased rows are swept;
  // the resolved item + the unrelated pending item survive.
  pendingEntityItem: string;
  pendingEdgeItem: string;
  pendingManualEdgeItem: string;
  resolvedItem: string;
  otherPendingItem: string;
}

// Seed a document with EVERY derived row type, plus an unrelated counterpart
// document (also linked as a duplicate, both directions) that must survive.
async function seed(tenantId: TenantId): Promise<Seeded> {
  const ctx = writeCtx(tenantId);
  const doc = (
    await store.insertDocument(ctx, {
      title: 'erase me',
      blobStorageUri: `file:///blobs/${tenantId}/erase-me`,
      accessTags: TAGS,
    })
  ).id;
  const other = (
    await store.insertDocument(ctx, {
      title: 'keep me',
      blobStorageUri: `file:///blobs/${tenantId}/keep-me`,
      accessTags: TAGS,
    })
  ).id;

  const paras = await store.insertParagraphsBulk(ctx, [
    { documentId: doc, paragraphIndex: 0, text: 'p0', accessTags: TAGS },
    { documentId: doc, paragraphIndex: 1, text: 'p1', accessTags: TAGS },
  ]);
  const paraIds = paras.map((p) => p.id);
  const [otherPara] = await store.insertParagraphsBulk(ctx, [
    { documentId: other, paragraphIndex: 0, text: 'other-p0', accessTags: TAGS },
  ]);

  const ext = (
    await store.upsertExtractorVersion(ctx, {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: `h-${tenantId}`,
      promptHash: 'p',
      modelId: MODEL,
    })
  ).id;
  const prov = (documentId: DocumentId, paragraphId: ParagraphId) => ({
    kind: 'document_extract' as const,
    documentId,
    paragraphId,
    extractorVersionId: ext,
    confidence: 1,
  });

  const e0 = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'e0' },
      accessTags: TAGS,
      provenance: prov(doc, paraIds[0]!),
    })
  ).id;
  const e1 = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'e1' },
      accessTags: TAGS,
      provenance: prov(doc, paraIds[0]!),
    })
  ).id;
  const otherEntity = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'other' },
      accessTags: TAGS,
      provenance: prov(other, otherPara!.id),
    })
  ).id;

  const edge = (
    await store.insertEdge(ctx, {
      type: 'related',
      fromEntityId: e0,
      toEntityId: e1,
      accessTags: TAGS,
      provenance: prov(doc, paraIds[0]!),
    })
  ).id;
  // A MANUAL-provenance edge between the doc's entities (source_document_id
  // NULL): step 3's provenance delete never sees it — only the entity CASCADE
  // removes it — so its id reaches the review sweep solely via the
  // incident-edge collection (step 1b). Pins that leg as load-bearing.
  const manualEdge = (
    await store.insertEdge(ctx, {
      type: 'related',
      fromEntityId: e1,
      toEntityId: e0,
      accessTags: TAGS,
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;

  // Embeddings: BOTH kinds for the target doc, plus the unrelated doc's vectors.
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: paraIds[0]!,
    modelId: MODEL,
    vector: vec(1),
    accessTags: TAGS,
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'entity',
    targetId: e0,
    modelId: MODEL,
    vector: vec(2),
    accessTags: TAGS,
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: otherPara!.id,
    modelId: MODEL,
    vector: vec(3),
    accessTags: TAGS,
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'entity',
    targetId: otherEntity,
    modelId: MODEL,
    vector: vec(4),
    accessTags: TAGS,
  });

  await store.insertCitationEvents(ctx, [
    { paragraphId: paraIds[0]!, documentId: doc },
    { paragraphId: paraIds[1]!, documentId: doc },
  ]);

  // Duplicate links BOTH directions, so the cascade on either FK is exercised.
  await store.recordDocumentDuplicate(ctx, {
    documentId: doc,
    duplicateOfDocumentId: other,
    method: 'near',
    score: 0.9,
  });
  await store.recordDocumentDuplicate(ctx, {
    documentId: other,
    duplicateOfDocumentId: doc,
    method: 'semantic',
    score: 0.8,
  });

  // Review items (F54): PENDING items targeting the doc's entity AND its edge
  // (must be swept — their proposed_change carries suggester-typed values), a
  // RESOLVED item targeting the doc's entity (must SURVIVE — the decision
  // trail), and a pending item for the unrelated doc's entity (must survive).
  const enqueue = (targetKind: string, targetId: string, note: string) =>
    store.enqueueReviewItem(ctx, {
      targetKind,
      targetId,
      proposedChange: { kind: 'correction', value: `suggested for ${note}` },
      accessTags: TAGS,
      note,
    });
  const pendingEntityItem = (await enqueue('entity', e0, 'erased entity')).id;
  const pendingEdgeItem = (await enqueue('edge', edge, 'erased edge')).id;
  // Targets the cascade-only manual edge — swept ONLY if step 1b collected it.
  const pendingManualEdgeItem = (await enqueue('edge', manualEdge, 'erased manual edge')).id;
  const resolvedItem = (await enqueue('entity', e1, 'resolved before erasure')).id;
  await store.resolveReviewItem(ctx, asReviewItemId(resolvedItem), { decision: 'rejected' });
  const otherPendingItem = (await enqueue('entity', otherEntity, 'unrelated target')).id;

  return {
    doc,
    paraIds,
    entityIds: [e0, e1],
    edgeId: edge,
    other,
    otherEntityId: otherEntity,
    otherParaId: otherPara!.id,
    pendingEntityItem,
    pendingEdgeItem,
    pendingManualEdgeItem,
    resolvedItem,
    otherPendingItem,
  };
}

async function countWhere(table: 'entities' | 'edges', docId: DocumentId): Promise<number> {
  const t = table === 'entities' ? entities : edges;
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(t)
    .where(eq(t.sourceDocumentId, docId));
  return Number(rows[0]?.value ?? 0);
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
  // NOTE: internal_bypass_log is append-only (a TRUNCATE-blocking tamper-evident
  // trigger), so it is NOT truncated here — tests scope their bypass-log
  // assertions by the (unique) document id instead of an absolute count.
  await db.execute(sql`TRUNCATE documents, paragraphs, entities, edges, embeddings,
    extractor_versions, citation_events, document_duplicates, review_queue, audit_events
    RESTART IDENTITY CASCADE`);
});

// The erasure bypass-log rows for a specific document (callSite + the documentId
// recorded in details), isolating this test's row from the append-only table.
async function erasureBypassRowsFor(docId: DocumentId) {
  return db
    .select()
    .from(internalBypassLog)
    .where(
      and(
        eq(internalBypassLog.callSite, 'graph.hard-delete'),
        sql`${internalBypassLog.details}->>'documentId' = ${docId}`,
      ),
    );
}

describe('hardDeleteDocument — INVARIANT 1: zero orphans + complete erasure', () => {
  it('removes EVERY derived row for the document and leaves NO set-null orphans', async () => {
    const s = await seed(TENANT_A);
    const bypass = bypassCtx(TENANT_A);

    const receipt = await store.hardDeleteDocument(writeCtx(TENANT_A), s.doc);

    // The document itself is gone.
    expect(await store.getDocument(bypass, s.doc)).toBeNull();
    // Paragraphs (cascade).
    expect(await store.findParagraphsByDocument(bypass, s.doc)).toEqual([]);
    // Entities + edges: GONE BY ID (deleted, not merely null-ed → no orphan).
    expect(await store.getEntitiesByIds(bypass, s.entityIds)).toEqual([]);
    // …and there is no row left pointing at (or recently pointing at) the doc.
    expect(await countWhere('entities', s.doc)).toBe(0);
    expect(await countWhere('edges', s.doc)).toBe(0);
    // The CRITICAL no-orphan assertion: a naive delete would SET NULL these and
    // leave them. None of our entity/edge ids survive with a null source doc.
    const orphanEntities = await db
      .select({ id: entities.id })
      .from(entities)
      .where(isNull(entities.sourceDocumentId));
    expect(orphanEntities).toEqual([]);
    const orphanEdges = await db
      .select({ id: edges.id })
      .from(edges)
      .where(isNull(edges.sourceDocumentId));
    expect(orphanEdges).toEqual([]);

    // Embeddings (polymorphic, both kinds) — none remain for the doc's targets.
    const remainingEmb = await db
      .select({ id: embeddings.id })
      .from(embeddings)
      .where(eq(embeddings.tenantId, TENANT_A));
    // Only the UNRELATED doc's two embeddings (paragraph + entity) survive.
    expect(remainingEmb).toHaveLength(2);

    // Citation events + duplicate links (cascade) — gone for the doc.
    const remainingCites = await db
      .select({ id: citationEvents.id })
      .from(citationEvents)
      .where(eq(citationEvents.documentId, s.doc));
    expect(remainingCites).toEqual([]);
    const remainingDups = await db.select({ id: documentDuplicates.id }).from(documentDuplicates);
    expect(remainingDups).toEqual([]); // both directions cascaded

    // Review queue (F54): no PENDING item survives pointing at an erased
    // target — the entity- and edge-targeting pending items are GONE…
    const queueRows = await db
      .select({ id: reviewQueue.id, status: reviewQueue.status })
      .from(reviewQueue)
      .where(eq(reviewQueue.tenantId, TENANT_A));
    const queueIds = queueRows.map((r) => r.id);
    expect(queueIds).not.toContain(s.pendingEntityItem);
    expect(queueIds).not.toContain(s.pendingEdgeItem);
    // The cascade-only manual edge's item is gone too — the incident-edge
    // collection (step 1b), not the provenance delete, had to find it.
    expect(queueIds).not.toContain(s.pendingManualEdgeItem);
    // …while the RESOLVED item (the decision trail) and the unrelated pending
    // item SURVIVE.
    expect(queueIds).toContain(s.resolvedItem);
    expect(queueIds).toContain(s.otherPendingItem);

    // No over-deletion: the unrelated counterpart document + its rows SURVIVE.
    expect(await store.getDocument(bypass, s.other)).not.toBeNull();
    expect(await store.getEntitiesByIds(bypass, [s.otherEntityId])).toHaveLength(1);
    expect(await store.findParagraphsByDocument(bypass, s.other)).toHaveLength(1);

    // The receipt counts are accurate + content-free.
    expect(receipt.documentId).toBe(s.doc);
    expect(receipt.tenantId).toBe(TENANT_A);
    expect(receipt.blobUri).toBe(`file:///blobs/${TENANT_A}/erase-me`);
    expect(receipt.deletedCounts).toEqual({
      embeddings: 2, // 1 paragraph vector + 1 entity vector
      entities: 2,
      edges: 1,
      paragraphs: 2,
      citationEvents: 2,
      duplicates: 2, // both link directions
      // The pending entity + provenance-edge + cascade-only manual-edge items
      // (the resolved one survives). NOTE the manual edge itself is NOT in
      // `edges` (that counts the step-3 provenance delete only — the
      // pre-existing count semantics documented on DocumentErasureCounts);
      // its review item IS swept.
      reviewItems: 3,
    });
    expect(receipt.actor).toBe(ACTOR);
  });

  it('writes exactly ONE content-free in-tx audit row + one bypass-log row', async () => {
    const s = await seed(TENANT_A);
    await store.hardDeleteDocument(writeCtx(TENANT_A), s.doc);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT_A));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('hard_delete_document');
    expect(audit[0]!.targetKind).toBe('document');
    expect(audit[0]!.targetId).toBe(s.doc);
    expect(audit[0]!.actor).toBe(ACTOR);
    // Content-free: only counts, no titles / text / properties.
    expect(audit[0]!.details).toEqual({
      deletedCounts: {
        embeddings: 2,
        entities: 2,
        edges: 1,
        paragraphs: 2,
        citationEvents: 2,
        duplicates: 2,
        reviewItems: 3,
      },
    });
    expect(JSON.stringify(audit[0]!.details)).not.toContain('erase me');

    // The access-filter bypass is recorded (one 'graph.hard-delete' row for this doc).
    expect(await erasureBypassRowsFor(s.doc)).toHaveLength(1);
  });

  it('a ROLLED-BACK erasure writes no audit row and erases nothing (in-tx guarantee)', async () => {
    const s = await seed(TENANT_A);
    await expect(
      store.withTransaction(writeCtx(TENANT_A), async (tx) => {
        await tx.hardDeleteDocument(writeCtx(TENANT_A), s.doc);
        throw new Error('boom'); // rolls back the whole transaction
      }),
    ).rejects.toThrow('boom');

    // Nothing was erased, and no audit / erasure-bypass row survived the rollback.
    expect(await store.getDocument(bypassCtx(TENANT_A), s.doc)).not.toBeNull();
    expect(await store.getEntitiesByIds(bypassCtx(TENANT_A), s.entityIds)).toHaveLength(2);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT_A))).toEqual(
      [],
    );
    expect(await erasureBypassRowsFor(s.doc)).toEqual([]);
  });

  it('is TENANT-SCOPED — cannot erase another tenant’s document', async () => {
    const a = await seed(TENANT_A);
    await expect(store.hardDeleteDocument(writeCtx(TENANT_B), a.doc)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Tenant A's document is untouched.
    expect(await store.getDocument(bypassCtx(TENANT_A), a.doc)).not.toBeNull();
    expect(await db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT_B))).toEqual(
      [],
    );
  });

  it('throws NotFoundError for an unknown document (no audit row)', async () => {
    const missing = asDocumentId('11111111-1111-1111-1111-111111111111');
    await expect(store.hardDeleteDocument(writeCtx(TENANT_A), missing)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await db.select().from(auditEvents)).toEqual([]);
  });
});

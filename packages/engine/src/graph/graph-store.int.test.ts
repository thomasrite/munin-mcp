// Integration tests for PostgresGraphStore — the P0 permission suite.
//
// Coverage:
//   - tenant isolation across every read path
//   - access-tag intersection semantics
//   - empty-tag-set semantics on both sides
//   - INTERNAL_BYPASS behaviour, including audit-log write and rollback
//   - soft-delete cascading to incident edges
//   - getEntitiesByIds partial visibility (silent filter, no leak)
//   - getNeighbours triple-filter behaviour
//   - CHECK constraint surfaced through the GraphStore as
//     InvalidProvenanceError
//
// If a deliberately-introduced bug in any access filter would still pass
// these tests, the suite is incomplete. See PERMISSION-MUTATION-TESTS.md
// in this directory for the documented mutation procedure.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { internalBypassLog, tenants } from '../db/schema';

import { InvalidProvenanceError } from './errors';
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
  internalBypass,
} from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-00000000aaaa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-00000000bbbb');
const ACTOR = asActorId('test-actor');

let docA: DocumentId;
let paraA: ParagraphId;
let extA: ExtractorVersionId;
let docB: DocumentId;
let paraB: ParagraphId;
let extB: ExtractorVersionId;

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
  // Truncate domain tables (NOT internal_bypass_log — that's append-only).
  // We respect the trigger by clearing other tables only. To clear bypass
  // log rows accumulated by tests we use a savepoint trick — disable the
  // trigger session-locally is also fine; here we simply tolerate
  // accumulation across tests and assert on counts via deltas.
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents,
    extractor_versions, audit_events, llm_calls, connector_state RESTART IDENTITY CASCADE`);

  // Insert fresh fixtures: a document, paragraph, and extractor_version
  // per tenant so document_extract entities can be created on either.
  docA = asDocumentId(crypto.randomUUID());
  paraA = asParagraphId(crypto.randomUUID());
  extA = asExtractorVersionId(crypto.randomUUID());
  docB = asDocumentId(crypto.randomUUID());
  paraB = asParagraphId(crypto.randomUUID());
  extB = asExtractorVersionId(crypto.randomUUID());

  const ctxA: WriteContext = { tenantId: TENANT_A, actor: ACTOR };
  const ctxB: WriteContext = { tenantId: TENANT_B, actor: ACTOR };

  await store.insertDocument(ctxA, {
    id: docA,
    title: 'Doc A',
    blobStorageUri: 'blob://a',
    accessTags: ['t:public'],
  });
  await store.insertParagraphsBulk(ctxA, [
    {
      id: paraA,
      documentId: docA,
      paragraphIndex: 0,
      text: 'paragraph A',
      accessTags: ['t:public'],
    },
  ]);
  await store.upsertExtractorVersion(ctxA, {
    id: extA,
    configurationId: 'test-cfg',
    configurationVersion: '0.1.0',
    schemaHash: 'h-a',
    promptHash: 'p-a',
    modelId: 'm-a',
  });

  await store.insertDocument(ctxB, {
    id: docB,
    title: 'Doc B',
    blobStorageUri: 'blob://b',
    accessTags: ['t:public'],
  });
  await store.insertParagraphsBulk(ctxB, [
    {
      id: paraB,
      documentId: docB,
      paragraphIndex: 0,
      text: 'paragraph B',
      accessTags: ['t:public'],
    },
  ]);
  await store.upsertExtractorVersion(ctxB, {
    id: extB,
    configurationId: 'test-cfg',
    configurationVersion: '0.1.0',
    schemaHash: 'h-b',
    promptHash: 'p-b',
    modelId: 'm-b',
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readCtx = (tenantId: TenantId, accessTags: readonly string[]): ReadContext => ({
  kind: 'regular',
  tenantId,
  accessTags,
  actor: ACTOR,
});

const bypassCtx = (tenantId: TenantId, callSite: string, reason: string): ReadContext => ({
  kind: 'bypass',
  tenantId,
  bypass: internalBypass(callSite, reason),
  actor: ACTOR,
});

const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

async function insertExtractedEntity(
  ctx: WriteContext,
  tags: readonly string[],
  doc: DocumentId,
  para: ParagraphId,
  ext: ExtractorVersionId,
): Promise<EntityId> {
  const e = await store.insertEntity(ctx, {
    type: 'Thing',
    properties: { name: `n-${crypto.randomUUID().slice(0, 4)}` },
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

async function bypassLogRowCount(): Promise<number> {
  const r = await db.select({ value: sql<number>`count(*)` }).from(internalBypassLog);
  return Number(r[0]?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Tenant isolation — across every read path
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('getEntity: tenant B cannot see entity inserted by tenant A even with matching tags', async () => {
    const idA = await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const seen = await store.getEntity(readCtx(TENANT_B, ['t:public']), idA);
    expect(seen).toBeNull();
  });

  it('getEntitiesByIds: cross-tenant ids filtered out silently', async () => {
    const idA = await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const idB = await insertExtractedEntity(writeCtx(TENANT_B), ['t:public'], docB, paraB, extB);
    const seen = await store.getEntitiesByIds(readCtx(TENANT_A, ['t:public']), [idA, idB]);
    const ids = seen.map((e) => e.id);
    expect(ids).toEqual([idA]);
  });

  it('findEntities: tenant A sees its own entities only', async () => {
    await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    await insertExtractedEntity(writeCtx(TENANT_B), ['t:public'], docB, paraB, extB);
    const page = await store.findEntities(readCtx(TENANT_A, ['t:public']), {});
    expect(page.total).toBe(2);
    expect(page.items.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });

  it('getDocument: tenant isolation', async () => {
    const seen = await store.getDocument(readCtx(TENANT_B, ['t:public']), docA);
    expect(seen).toBeNull();
  });

  it('getParagraph: tenant isolation', async () => {
    const seen = await store.getParagraph(readCtx(TENANT_B, ['t:public']), paraA);
    expect(seen).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Access-tag intersection — any-of semantics
// ---------------------------------------------------------------------------

describe('access-tag intersection (any-of)', () => {
  it('caller with overlapping tag sees entity', async () => {
    const id = await insertExtractedEntity(writeCtx(TENANT_A), ['t:a', 't:b'], docA, paraA, extA);
    const seen = await store.getEntity(readCtx(TENANT_A, ['t:a']), id);
    expect(seen?.id).toBe(id);
  });

  it('caller with non-overlapping tag does not see entity', async () => {
    const id = await insertExtractedEntity(writeCtx(TENANT_A), ['t:a', 't:b'], docA, paraA, extA);
    const seen = await store.getEntity(readCtx(TENANT_A, ['t:c']), id);
    expect(seen).toBeNull();
  });

  it('caller with one of many tags sees entity (any-of, not all-of)', async () => {
    const id = await insertExtractedEntity(
      writeCtx(TENANT_A),
      ['t:a', 't:b', 't:c'],
      docA,
      paraA,
      extA,
    );
    const seen = await store.getEntity(readCtx(TENANT_A, ['t:a']), id);
    expect(seen?.id).toBe(id);
  });

  it('caller with empty tag set sees nothing (not "no filter")', async () => {
    await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const page = await store.findEntities(readCtx(TENANT_A, []), {});
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });

  it('entity with empty tags is invisible to non-empty callers (symmetric)', async () => {
    const id = await insertExtractedEntity(writeCtx(TENANT_A), [], docA, paraA, extA);
    const seen = await store.getEntity(readCtx(TENANT_A, ['t:anything']), id);
    expect(seen).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INTERNAL_BYPASS
// ---------------------------------------------------------------------------

describe('INTERNAL_BYPASS', () => {
  it('returns entities the caller would normally not see', async () => {
    const id = await insertExtractedEntity(writeCtx(TENANT_A), ['t:restricted'], docA, paraA, extA);
    // With regular ctx and no overlap → invisible.
    const blocked = await store.getEntity(readCtx(TENANT_A, ['t:anything']), id);
    expect(blocked).toBeNull();
    // With bypass ctx → visible.
    const seen = await store.getEntity(
      bypassCtx(TENANT_A, 'test.bypass.getEntity', 'forensic test'),
      id,
    );
    expect(seen?.id).toBe(id);
  });

  it('writes an internal_bypass_log row in the same transaction', async () => {
    const id = await insertExtractedEntity(writeCtx(TENANT_A), ['t:x'], docA, paraA, extA);
    const before = await bypassLogRowCount();
    await store.getEntity(bypassCtx(TENANT_A, 'site.alpha', 'because tests'), id);
    const after = await bypassLogRowCount();
    expect(after).toBe(before + 1);

    const rows = await db
      .select()
      .from(internalBypassLog)
      .where(eq(internalBypassLog.callSite, 'site.alpha'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('because tests');
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  it('does not bypass tenant isolation — bypass on tenant A cannot see tenant B', async () => {
    const idB = await insertExtractedEntity(writeCtx(TENANT_B), ['t:x'], docB, paraB, extB);
    const seen = await store.getEntity(
      bypassCtx(TENANT_A, 'cross.tenant.attempt', 'should not work'),
      idB,
    );
    expect(seen).toBeNull();
  });

  it('rejects empty callSite or reason at token construction', () => {
    expect(() => internalBypass('', 'reason')).toThrow();
    expect(() => internalBypass('site', '')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Soft-delete cascading
// ---------------------------------------------------------------------------

describe('soft-delete cascade', () => {
  it('softDeleteEntity also soft-deletes incident edges', async () => {
    const a = await insertExtractedEntity(writeCtx(TENANT_A), ['t:x'], docA, paraA, extA);
    const b = await insertExtractedEntity(writeCtx(TENANT_A), ['t:x'], docA, paraA, extA);
    const c = await insertExtractedEntity(writeCtx(TENANT_A), ['t:x'], docA, paraA, extA);
    const edge1 = await store.insertEdge(writeCtx(TENANT_A), {
      type: 'related',
      fromEntityId: a,
      toEntityId: b,
      accessTags: ['t:x'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extA,
        confidence: 0.9,
      },
    });
    const edge2 = await store.insertEdge(writeCtx(TENANT_A), {
      type: 'related',
      fromEntityId: c,
      toEntityId: a,
      accessTags: ['t:x'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extA,
        confidence: 0.9,
      },
    });
    // Unrelated edge between b and c — should survive.
    const edge3 = await store.insertEdge(writeCtx(TENANT_A), {
      type: 'related',
      fromEntityId: b,
      toEntityId: c,
      accessTags: ['t:x'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extA,
        confidence: 0.9,
      },
    });

    await store.softDeleteEntity(writeCtx(TENANT_A), a);

    const e1 = await store.getEdge(readCtx(TENANT_A, ['t:x']), edge1.id);
    const e2 = await store.getEdge(readCtx(TENANT_A, ['t:x']), edge2.id);
    const e3 = await store.getEdge(readCtx(TENANT_A, ['t:x']), edge3.id);
    expect(e1).toBeNull();
    expect(e2).toBeNull();
    expect(e3?.id).toBe(edge3.id);
  });
});

// ---------------------------------------------------------------------------
// getNeighbours triple filter
// ---------------------------------------------------------------------------

describe('getNeighbours triple filter', () => {
  it('omits neighbour when far endpoint is invisible to caller', async () => {
    const a = await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const b = await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const c = await insertExtractedEntity(writeCtx(TENANT_A), ['t:restricted'], docA, paraA, extA);
    await store.insertEdge(writeCtx(TENANT_A), {
      type: 'related',
      fromEntityId: a,
      toEntityId: b,
      accessTags: ['t:public'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extA,
        confidence: 0.9,
      },
    });
    await store.insertEdge(writeCtx(TENANT_A), {
      type: 'related',
      fromEntityId: a,
      toEntityId: c,
      accessTags: ['t:public'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extA,
        confidence: 0.9,
      },
    });

    const out = await store.getNeighbours(readCtx(TENANT_A, ['t:public']), a, {
      direction: 'out',
    });
    expect(out.entities.map((e) => e.id)).toEqual([b]);
  });

  it('omits neighbour when edge itself is invisible', async () => {
    const a = await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const b = await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    await store.insertEdge(writeCtx(TENANT_A), {
      type: 'related',
      fromEntityId: a,
      toEntityId: b,
      accessTags: ['t:secret'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extA,
        confidence: 0.9,
      },
    });
    const out = await store.getNeighbours(readCtx(TENANT_A, ['t:public']), a, {
      direction: 'out',
    });
    expect(out.edges).toEqual([]);
    expect(out.entities).toEqual([]);
  });

  it('returns empty when start entity is invisible', async () => {
    const a = await insertExtractedEntity(writeCtx(TENANT_A), ['t:restricted'], docA, paraA, extA);
    const out = await store.getNeighbours(readCtx(TENANT_A, ['t:public']), a, {
      direction: 'both',
    });
    expect(out.entities).toEqual([]);
    expect(out.edges).toEqual([]);
  });
});

describe('findEntitiesByParagraphIds', () => {
  it('returns entities extracted from the given paragraphs, access-filtered', async () => {
    const visible = await insertExtractedEntity(
      writeCtx(TENANT_A),
      ['t:public'],
      docA,
      paraA,
      extA,
    );
    const hidden = await insertExtractedEntity(
      writeCtx(TENANT_A),
      ['t:restricted'],
      docA,
      paraA,
      extA,
    );

    const asPublic = await store.findEntitiesByParagraphIds(readCtx(TENANT_A, ['t:public']), [
      paraA,
    ]);
    expect(asPublic.map((e) => e.id)).toEqual([visible]);

    const asRestricted = await store.findEntitiesByParagraphIds(
      readCtx(TENANT_A, ['t:public', 't:restricted']),
      [paraA],
    );
    expect(asRestricted.map((e) => e.id).sort()).toEqual([visible, hidden].sort());
  });

  it('does not cross tenant boundaries', async () => {
    await insertExtractedEntity(writeCtx(TENANT_B), ['t:public'], docB, paraB, extB);
    const out = await store.findEntitiesByParagraphIds(readCtx(TENANT_A, ['t:public']), [paraB]);
    expect(out).toEqual([]);
  });

  it('empty caller tag set returns nothing', async () => {
    await insertExtractedEntity(writeCtx(TENANT_A), ['t:public'], docA, paraA, extA);
    const out = await store.findEntitiesByParagraphIds(readCtx(TENANT_A, []), [paraA]);
    expect(out).toEqual([]);
  });

  it('returns empty for an empty id list without querying', async () => {
    const out = await store.findEntitiesByParagraphIds(readCtx(TENANT_A, ['t:public']), []);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CHECK constraint surfaced as a typed error
// ---------------------------------------------------------------------------

describe('CHECK constraint surfaced through GraphStore', () => {
  it('rejects document_extract entity missing paragraphId via InvalidProvenanceError', async () => {
    await expect(
      store.insertEntity(writeCtx(TENANT_A), {
        type: 'Thing',
        properties: {},
        accessTags: ['t:x'],
        provenance: {
          kind: 'document_extract',
          documentId: docA,
          paragraphId: '' as ParagraphId,
          extractorVersionId: extA,
          confidence: 0.5,
        },
      }),
    ).rejects.toBeInstanceOf(InvalidProvenanceError);
  });

  it('rejects confidence outside [0,1]', async () => {
    await expect(
      store.insertEntity(writeCtx(TENANT_A), {
        type: 'Thing',
        properties: {},
        accessTags: ['t:x'],
        provenance: {
          kind: 'document_extract',
          documentId: docA,
          paragraphId: paraA,
          extractorVersionId: extA,
          confidence: 1.5,
        },
      }),
    ).rejects.toBeInstanceOf(InvalidProvenanceError);
  });
});

// ---------------------------------------------------------------------------
// Document metadata round-trip (P3a) — sensitivity_class_id + simhash + version
// ---------------------------------------------------------------------------

describe('document metadata persistence (P3a)', () => {
  it('persists and exposes sensitivity_class_id (opaque) through the read shape', async () => {
    const withClass = await store.insertDocument(writeCtx(TENANT_A), {
      title: 'classified',
      blobStorageUri: 'b://c',
      sensitivityClassId: 'hr_confidential',
      accessTags: ['t:public'],
    });
    expect(withClass.sensitivityClassId).toBe('hr_confidential');
    const read = await store.getDocument(readCtx(TENANT_A, ['t:public']), withClass.id);
    expect(read?.sensitivityClassId).toBe('hr_confidential');
  });

  it('defaults sensitivity_class_id to null when not supplied', async () => {
    const noClass = await store.insertDocument(writeCtx(TENANT_A), {
      title: 'unclassified',
      blobStorageUri: 'b://u',
      accessTags: ['t:public'],
    });
    expect(noClass.sensitivityClassId).toBeNull();
    const read = await store.getDocument(readCtx(TENANT_A, ['t:public']), noClass.id);
    expect(read?.sensitivityClassId).toBeNull();
  });

  it('persists simhash + version fields on insert (round-trip)', async () => {
    const doc = await store.insertDocument(writeCtx(TENANT_A), {
      title: 'fingerprinted',
      blobStorageUri: 'b://f',
      simhash: 'abcdef0123456789',
      versionSeq: 3,
      accessTags: ['t:public'],
    });
    // simhash is read via findDocumentFingerprints, not the Document read shape.
    const fps = await store.findDocumentFingerprints(readCtx(TENANT_A, ['t:public']), {
      limit: 100,
    });
    expect(fps.find((f) => f.id === doc.id)?.simhash).toBe('abcdef0123456789');
    const read = await store.getDocument(readCtx(TENANT_A, ['t:public']), doc.id);
    expect(read?.versionSeq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('withTransaction', () => {
  it('rolls back all writes if the callback throws', async () => {
    await expect(
      store.withTransaction(writeCtx(TENANT_A), async (tx) => {
        await tx.insertEntity(writeCtx(TENANT_A), {
          type: 'Thing',
          properties: {},
          accessTags: ['t:x'],
          provenance: { kind: 'manual', confidence: null },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const page = await store.findEntities(readCtx(TENANT_A, ['t:x']), {});
    expect(page.total).toBe(0);
  });

  it('commits all writes when the callback resolves', async () => {
    await store.withTransaction(writeCtx(TENANT_A), async (tx) => {
      await tx.insertEntity(writeCtx(TENANT_A), {
        type: 'Thing',
        properties: { n: 1 },
        accessTags: ['t:x'],
        provenance: { kind: 'manual', confidence: null },
      });
      await tx.insertEntity(writeCtx(TENANT_A), {
        type: 'Thing',
        properties: { n: 2 },
        accessTags: ['t:x'],
        provenance: { kind: 'manual', confidence: null },
      });
    });
    const page = await store.findEntities(readCtx(TENANT_A, ['t:x']), {});
    expect(page.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Vector search — permission matrix
// ---------------------------------------------------------------------------
//
// These tests use fabricated 1024-D vectors (random walks from a seed) so
// they don't depend on a real embedding provider. They verify the
// permission contract on the search path: tenant isolation, access-tag
// intersection, INTERNAL_BYPASS behaviour, model_id filtering, and the
// access_tags-sync trigger from migration 0001.

function fakeVector(seed: number, dims = 1024): number[] {
  const v: number[] = [];
  let state = seed * 2654435761;
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const x = (state / 0x7fffffff) * 2 - 1;
    v.push(x);
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

describe('searchByVector — permission matrix', () => {
  it('returns embeddings only for the calling tenant', async () => {
    const pA = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 1, text: 'tenant A para', accessTags: ['t:public'] },
      ])
    )[0]!;
    const pB = (
      await store.insertParagraphsBulk(writeCtx(TENANT_B), [
        { documentId: docB, paragraphIndex: 1, text: 'tenant B para', accessTags: ['t:public'] },
      ])
    )[0]!;

    const vA = fakeVector(1);
    const vB = fakeVector(2);
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: pA.id,
      modelId: 'test-model',
      vector: vA,
    });
    await store.upsertEmbedding(writeCtx(TENANT_B), {
      targetKind: 'paragraph',
      targetId: pB.id,
      modelId: 'test-model',
      vector: vB,
    });

    const results = await store.searchByVector(readCtx(TENANT_A, ['t:public']), {
      modelId: 'test-model',
      k: 10,
      queryVector: vA,
    });
    expect(results.length).toBe(1);
    expect(results[0]?.targetId).toBe(pA.id);
  });

  it('respects access_tags intersection on search', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 2, text: 'restricted', accessTags: ['t:restricted'] },
      ])
    )[0]!;
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(3),
    });

    const blocked = await store.searchByVector(readCtx(TENANT_A, ['t:public']), {
      modelId: 'test-model',
      k: 10,
      queryVector: fakeVector(3),
    });
    expect(blocked.find((r) => r.targetId === p.id)).toBeUndefined();

    const visible = await store.searchByVector(readCtx(TENANT_A, ['t:restricted']), {
      modelId: 'test-model',
      k: 10,
      queryVector: fakeVector(3),
    });
    expect(visible.find((r) => r.targetId === p.id)).toBeDefined();
  });

  it('empty caller tag set returns no embeddings', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 3, text: 'p', accessTags: ['t:public'] },
      ])
    )[0]!;
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(4),
    });
    const results = await store.searchByVector(readCtx(TENANT_A, []), {
      modelId: 'test-model',
      k: 10,
      queryVector: fakeVector(4),
    });
    expect(results).toEqual([]);
  });

  it('INTERNAL_BYPASS returns hidden embeddings and writes one audit row', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 4, text: 'p', accessTags: ['t:secret'] },
      ])
    )[0]!;
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(5),
    });

    const before = await bypassLogRowCount();
    const results = await store.searchByVector(
      bypassCtx(TENANT_A, 'test.searchByVector', 'verify bypass'),
      { modelId: 'test-model', k: 10, queryVector: fakeVector(5) },
    );
    expect(results.find((r) => r.targetId === p.id)).toBeDefined();
    expect(await bypassLogRowCount()).toBe(before + 1);
  });

  it('filters by modelId — embeddings under model A invisible to a query for model B', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 5, text: 'p', accessTags: ['t:public'] },
      ])
    )[0]!;
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'model-A',
      vector: fakeVector(6),
    });
    const results = await store.searchByVector(readCtx(TENANT_A, ['t:public']), {
      modelId: 'model-B',
      k: 10,
      queryVector: fakeVector(6),
    });
    expect(results.find((r) => r.targetId === p.id)).toBeUndefined();
  });

  it('upsertEmbedding is idempotent on (target, model) — re-embedding replaces the vector', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 6, text: 'p', accessTags: ['t:public'] },
      ])
    )[0]!;
    const first = await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(7),
    });
    const second = await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(8),
    });
    expect(second.id).toBe(first.id);

    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(internalBypassLog)
      .where(eq(internalBypassLog.callSite, 'noop'));
    expect(Number(rows[0]?.count ?? 0)).toBe(0); // sanity: no bypass writes
  });
});

describe('searchByVector — HNSW ef_search (F43)', () => {
  it('issues SET LOCAL hnsw.ef_search (≥100, ≥k) inside the search transaction', async () => {
    // A query-capturing drizzle logger over the SAME connection proves the SET is
    // actually executed (not a silent no-op) and lands INSIDE the search transaction.
    const captured: string[] = [];
    const loggedDb = drizzle(client, { logger: { logQuery: (q) => captured.push(q) } });
    const loggedStore = new PostgresGraphStore(loggedDb);

    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 9, text: 'ef-search probe', accessTags: ['t:public'] },
      ])
    )[0]!;
    const v = fakeVector(11);
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: v,
    });

    // k below the floor → ef_search clamps to the 100 floor; results still return.
    captured.length = 0;
    const small = await loggedStore.searchByVector(readCtx(TENANT_A, ['t:public']), {
      modelId: 'test-model',
      k: 10,
      queryVector: v,
    });
    expect(small.some((r) => r.targetId === p.id)).toBe(true);
    expect(captured.some((q) => /set local hnsw\.ef_search\s*=\s*100\b/i.test(q))).toBe(true);

    // k above the floor → ef_search tracks the limit (≥ k), never the default 40.
    captured.length = 0;
    await loggedStore.searchByVector(readCtx(TENANT_A, ['t:public']), {
      modelId: 'test-model',
      k: 250,
      queryVector: v,
    });
    expect(captured.some((q) => /set local hnsw\.ef_search\s*=\s*250\b/i.test(q))).toBe(true);
  });
});

describe('searchByKeyword — any-term (OR) semantics', () => {
  it('a full-sentence query matches a paragraph sharing ANY salient term (not ALL)', async () => {
    // Under the old plainto_tsquery (AND) semantics a multi-word question matched
    // only a paragraph containing EVERY salient term — which no single paragraph
    // here does — so the lexical half returned nothing. With OR semantics the
    // term-sharing paragraph is found and the unrelated one is not.
    const inserted = await store.insertParagraphsBulk(writeCtx(TENANT_A), [
      {
        documentId: docA,
        paragraphIndex: 20,
        // shares "design" / "review" / "Apollo" / "project" with the query, but
        // NOT "outcome" — so an ALL-terms (AND) query would miss it.
        text: 'Design review notes for the Apollo project, led by Alex Carter.',
        accessTags: ['t:public'],
      },
      {
        documentId: docA,
        paragraphIndex: 21,
        // shares no salient term with the query.
        text: 'The office stationery order was delivered on Tuesday.',
        accessTags: ['t:public'],
      },
    ]);
    const related = inserted[0]!;
    const unrelated = inserted[1]!;

    const res = await store.searchByKeyword(readCtx(TENANT_A, ['t:public']), {
      query: 'what was the outcome of the design review for the Apollo project?',
      k: 10,
    });
    const ids = res.map((r) => r.targetId);
    expect(ids).toContain(related.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it('ranks a paragraph sharing more query terms above one sharing fewer', async () => {
    const inserted = await store.insertParagraphsBulk(writeCtx(TENANT_A), [
      {
        documentId: docA,
        paragraphIndex: 22,
        text: 'Design review outcome: the Apollo milestone was approved by the team.',
        accessTags: ['t:public'],
      },
      {
        documentId: docA,
        paragraphIndex: 23,
        text: 'A note about the design process generally.',
        accessTags: ['t:public'],
      },
    ]);
    const dense = inserted[0]!;
    const sparse = inserted[1]!;

    const res = await store.searchByKeyword(readCtx(TENANT_A, ['t:public']), {
      query: 'what was the design review outcome',
      k: 10,
    });
    const denseRank = res.findIndex((r) => r.targetId === dense.id);
    const sparseRank = res.findIndex((r) => r.targetId === sparse.id);
    expect(denseRank).toBeGreaterThanOrEqual(0);
    expect(sparseRank).toBeGreaterThanOrEqual(0);
    expect(denseRank).toBeLessThan(sparseRank); // more term-dense ranks first
  });

  it('still applies the access-tag filter on the OR path (no permission widening)', async () => {
    const inserted = await store.insertParagraphsBulk(writeCtx(TENANT_A), [
      {
        documentId: docA,
        paragraphIndex: 24,
        text: 'Confidential design review outcome for a restricted project.',
        accessTags: ['t:restricted'],
      },
    ]);
    const restricted = inserted[0]!;
    const res = await store.searchByKeyword(readCtx(TENANT_A, ['t:public']), {
      query: 'design review outcome project',
      k: 10,
    });
    expect(res.map((r) => r.targetId)).not.toContain(restricted.id);
  });
});

describe('access_tags sync trigger (migration 0001)', () => {
  it('insert: embedding inherits access_tags from paragraph when omitted', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 7, text: 'p', accessTags: ['t:inherit'] },
      ])
    )[0]!;
    const emb = await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(9),
      // accessTags intentionally omitted
    });
    expect(emb.accessTags).toEqual(['t:inherit']);
  });

  it('update: changing paragraph access_tags cascades to embedding', async () => {
    const p = (
      await store.insertParagraphsBulk(writeCtx(TENANT_A), [
        { documentId: docA, paragraphIndex: 8, text: 'p', accessTags: ['t:orig'] },
      ])
    )[0]!;
    await store.upsertEmbedding(writeCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: 'test-model',
      vector: fakeVector(10),
    });

    // Update the paragraph's access_tags via raw SQL (we don't have a
    // GraphStore.updateParagraph in 1.4; the trigger fires regardless).
    await db.execute(
      sql`UPDATE paragraphs SET access_tags = ARRAY['t:new']::text[] WHERE id = ${p.id}`,
    );

    const rows = await db.execute(
      sql`SELECT access_tags FROM embeddings WHERE target_id = ${p.id} AND target_kind = 'paragraph'`,
    );
    const row = (rows as unknown as Array<{ access_tags: string[] }>)[0];
    expect(row?.access_tags).toEqual(['t:new']);
  });
});

// ---------------------------------------------------------------------------
// upsertExtractorVersion idempotency
// ---------------------------------------------------------------------------

describe('upsertExtractorVersion', () => {
  it('returns the existing row on natural-key conflict', async () => {
    const first = await store.upsertExtractorVersion(writeCtx(TENANT_A), {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: 'sh',
      promptHash: 'ph',
      modelId: 'm',
    });
    const second = await store.upsertExtractorVersion(writeCtx(TENANT_A), {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: 'sh',
      promptHash: 'ph',
      modelId: 'm',
    });
    expect(second.id).toBe(first.id);
  });

  it('different tenants with the same natural key produce different rows', async () => {
    const a = await store.upsertExtractorVersion(writeCtx(TENANT_A), {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: 'sh',
      promptHash: 'ph',
      modelId: 'm',
    });
    const b = await store.upsertExtractorVersion(writeCtx(TENANT_B), {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: 'sh',
      promptHash: 'ph',
      modelId: 'm',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.tenantId).toBe(TENANT_A);
    expect(b.tenantId).toBe(TENANT_B);
  });
});

// ---------------------------------------------------------------------------
// Extraction maintenance: findParagraphsPendingExtraction +
// softDeleteExtractionsBySchema (F1 — replaced the extract-cli raw SQL)
// ---------------------------------------------------------------------------
describe('extraction maintenance methods', () => {
  it('findParagraphsPendingExtraction excludes already-extracted paragraphs, includes the rest', async () => {
    const ctx = writeCtx(TENANT_A);
    const bp = bypassCtx(TENANT_A, 'test.pending', 'read pending paragraphs');
    await insertExtractedEntity(ctx, ['t:public'], docA, paraA, extA); // paraA → h-a
    const para2 = asParagraphId(crypto.randomUUID());
    await store.insertParagraphsBulk(ctx, [
      { id: para2, documentId: docA, paragraphIndex: 1, text: 'para 2', accessTags: ['t:public'] },
    ]);
    const ids = (await store.findParagraphsPendingExtraction(bp, { schemaHash: 'h-a' })).map(
      (p) => p.id,
    );
    expect(ids).toContain(para2);
    expect(ids).not.toContain(paraA);
  });

  it('softDeleteExtractionsBySchema clears stale-schema entities + incident edges, keeps current', async () => {
    const ctx = writeCtx(TENANT_A);
    const bp = bypassCtx(TENANT_A, 'test.pending', 'read graph');
    const eCurrent = await insertExtractedEntity(ctx, ['t:public'], docA, paraA, extA);
    const extOld = await store.upsertExtractorVersion(ctx, {
      configurationId: 'test-cfg',
      configurationVersion: '0.0.1',
      schemaHash: 'h-old',
      promptHash: 'p-old',
      modelId: 'm-a',
    });
    const para2 = asParagraphId(crypto.randomUUID());
    await store.insertParagraphsBulk(ctx, [
      { id: para2, documentId: docA, paragraphIndex: 1, text: 'para 2', accessTags: ['t:public'] },
    ]);
    const eOld1 = await insertExtractedEntity(ctx, ['t:public'], docA, para2, extOld.id);
    const eOld2 = await insertExtractedEntity(ctx, ['t:public'], docA, para2, extOld.id);
    await store.insertEdge(ctx, {
      type: 'related',
      fromEntityId: eOld1,
      toEntityId: eOld2,
      accessTags: ['t:public'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: para2,
        extractorVersionId: extOld.id,
        confidence: null,
      },
    });

    const removed = await store.softDeleteExtractionsBySchema(ctx, { keepSchemaHash: 'h-a' });
    expect(removed.entitiesDeleted).toBe(2);
    expect(removed.edgesDeleted).toBe(1);

    expect(await store.getEntity(bp, eCurrent)).not.toBeNull();
    expect(await store.getEntity(bp, eOld1)).toBeNull();
    expect(await store.getEntity(bp, eOld2)).toBeNull();

    const pending = (await store.findParagraphsPendingExtraction(bp, { schemaHash: 'h-a' })).map(
      (p) => p.id,
    );
    expect(pending).toContain(para2);
    expect(pending).not.toContain(paraA);
  });

  it('softDeleteExtractionsBySchema removes a stale-schema edge between current-schema entities (step 3 fires independently of the cascade)', async () => {
    const ctx = writeCtx(TENANT_A);
    const bp = bypassCtx(TENANT_A, 'test.pending', 'read graph');
    // Two CURRENT-schema (h-a) entities — neither will be soft-deleted.
    const e1 = await insertExtractedEntity(ctx, ['t:public'], docA, paraA, extA);
    const e2 = await insertExtractedEntity(ctx, ['t:public'], docA, paraA, extA);
    const extOld = await store.upsertExtractorVersion(ctx, {
      configurationId: 'test-cfg',
      configurationVersion: '0.0.1',
      schemaHash: 'h-old',
      promptHash: 'p-old',
      modelId: 'm-a',
    });
    // A STALE-schema edge between the two current-schema entities.
    const edge = await store.insertEdge(ctx, {
      type: 'related',
      fromEntityId: e1,
      toEntityId: e2,
      accessTags: ['t:public'],
      provenance: {
        kind: 'document_extract',
        documentId: docA,
        paragraphId: paraA,
        extractorVersionId: extOld.id,
        confidence: null,
      },
    });

    const removed = await store.softDeleteExtractionsBySchema(ctx, { keepSchemaHash: 'h-a' });
    expect(removed.entitiesDeleted).toBe(0); // both endpoints are current-schema
    expect(removed.edgesDeleted).toBe(1); // the stale-schema edge, via step 3
    expect(await store.getEdge(bp, edge.id)).toBeNull();
    expect(await store.getEntity(bp, e1)).not.toBeNull();
    expect(await store.getEntity(bp, e2)).not.toBeNull();
  });

  it('batched readers short-circuit on an empty id list', async () => {
    const bp = bypassCtx(TENANT_A, 'test.pending', 'read graph');
    expect(await store.getDocumentsByIds(bp, [])).toEqual([]);
    expect(await store.getParagraphsByIds(bp, [])).toEqual([]);
  });

  it('softDeleteExtractionsBySchema is tenant-scoped', async () => {
    const bpB = bypassCtx(TENANT_B, 'test.pending', 'read tenant B');
    const eB = await insertExtractedEntity(writeCtx(TENANT_B), ['t:public'], docB, paraB, extB);
    await store.softDeleteExtractionsBySchema(writeCtx(TENANT_A), { keepSchemaHash: 'h-a' });
    expect(await store.getEntity(bpB, eB)).not.toBeNull();
  });
});

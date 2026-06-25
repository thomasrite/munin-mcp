// ===========================================================================
// PERMISSION MATRIX — P0. DO NOT SKIP, DO NOT WEAKEN.
// ===========================================================================
//
// The canonical, systematic permission test for Munin. Access control is the
// trust-critical property: a caller must never see an entity, edge, document,
// paragraph, or vector hit their access tags don't permit, and never cross a
// tenant boundary. This suite covers every GraphStoreReader method across the
// dimensions {tenant isolation, access-tag any-of (positive + negative),
// empty-tag-set → nothing, soft-delete exclusion}, plus getNeighbours
// triple-filter, searchByVector, writes, INTERNAL_BYPASS, the catastrophic
// cross-tenant contamination case, and an automated deliberate-bug canary.
//
// Runs in the default `pnpm test` (cannot be skipped) and `pnpm test:int`.
// The companion no-skip-guard + bypass-inventory guards keep it honest; the
// manual checklist in graph/PERMISSION-MUTATION-TESTS.md is the backstop for
// the dimensions the canary can't cleanly automate.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { internalBypassLog, paragraphs, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type EdgeId,
  type EntityId,
  type ExtractorVersionId,
  type ParagraphId,
  type ReadContext,
  type ReviewItemId,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  internalBypass,
} from '../graph/types';
import { VulnerableGraphStoreReader } from './vulnerable-store.test-helper';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000aa');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000bb');
const ACTOR = asActorId('perm-matrix');
const MODEL = 'perm-model';
const CONN = '@muninhq/connector-test';

// Caller tag sets.
const PUB = ['t:pub'];
const SECRET = ['t:secret'];
const BOTH = ['t:pub', 't:secret'];
const EMPTY: readonly string[] = [];
const WRONG = ['t:other'];

const readCtx = (tenantId: TenantId, accessTags: readonly string[]): ReadContext => ({
  kind: 'regular',
  tenantId,
  accessTags,
  actor: ACTOR,
});
const bypassCtx = (tenantId: TenantId): ReadContext => ({
  kind: 'bypass',
  tenantId,
  bypass: internalBypass('perm-matrix.test', 'test reads full graph'),
  actor: ACTOR,
});
const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

function fakeVector(seed: number, dims = 1024): number[] {
  const v: number[] = [];
  let state = (seed + 1) * 2654435761;
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

// --- per-tenant fixture handles, re-seeded each test ---
interface Fixture {
  doc: DocumentId;
  docSecret: DocumentId;
  pubSha: string;
  secretSha: string;
  pubExternal: string;
  secretExternal: string;
  paraPub: ParagraphId;
  paraSecret: ParagraphId;
  ext: ExtractorVersionId;
  entityPub: EntityId;
  entitySecret: EntityId;
  entityDeleted: EntityId;
  edgePub: EdgeId;
  reviewPub: ReviewItemId;
  reviewSecret: ReviewItemId;
}
let a: Fixture;
let b: Fixture;

async function seed(tenantId: TenantId, prefix: string): Promise<Fixture> {
  const ctx = writeCtx(tenantId);
  const pubSha = `${prefix}-pub-sha`;
  const secretSha = `${prefix}-secret-sha`;
  const pubExternal = `${prefix}-ext-pub`;
  const secretExternal = `${prefix}-ext-secret`;
  const doc = (
    await store.insertDocument(ctx, {
      title: 'pub doc',
      blobStorageUri: 'b://d',
      sha256: pubSha,
      simhash: `${prefix}00000000000000`.slice(0, 16),
      connectorPackage: CONN,
      externalId: pubExternal,
      accessTags: PUB,
    })
  ).id;
  const docSecret = (
    await store.insertDocument(ctx, {
      title: 'secret doc',
      blobStorageUri: 'b://s',
      sha256: secretSha,
      simhash: `${prefix}ffffffffffffff`.slice(0, 16),
      connectorPackage: CONN,
      externalId: secretExternal,
      accessTags: SECRET,
    })
  ).id;
  // A near-duplicate link PUB-doc → SECRET-doc, so the no-leak test can prove a
  // link is returned ONLY when BOTH endpoints are visible to the caller.
  await store.recordDocumentDuplicate(ctx, {
    documentId: doc,
    duplicateOfDocumentId: docSecret,
    method: 'near',
    score: 0.97,
  });
  const paraPub = (
    await store.insertParagraphsBulk(ctx, [
      { documentId: doc, paragraphIndex: 0, text: 'public paragraph', accessTags: PUB },
    ])
  )[0]!.id;
  const paraSecret = (
    await store.insertParagraphsBulk(ctx, [
      { documentId: docSecret, paragraphIndex: 0, text: 'secret paragraph', accessTags: SECRET },
    ])
  )[0]!.id;
  const ext = (
    await store.upsertExtractorVersion(ctx, {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: `h-${tenantId}`,
      promptHash: 'p',
      modelId: MODEL,
    })
  ).id;

  const prov = (para: ParagraphId) => ({
    kind: 'document_extract' as const,
    documentId: doc,
    paragraphId: para,
    extractorVersionId: ext,
    confidence: 1,
  });
  const entityPub = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'pub' },
      accessTags: PUB,
      provenance: prov(paraPub),
    })
  ).id;
  const entitySecret = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'secret' },
      accessTags: SECRET,
      provenance: prov(paraPub),
    })
  ).id;
  const entityDeleted = (
    await store.insertEntity(ctx, {
      type: 'Thing',
      properties: { name: 'gone' },
      accessTags: PUB,
      provenance: prov(paraPub),
    })
  ).id;
  await store.softDeleteEntity(ctx, entityDeleted);

  const edgePub = (
    await store.insertEdge(ctx, {
      type: 'related',
      fromEntityId: entityPub,
      toEntityId: entitySecret,
      accessTags: PUB,
      provenance: prov(paraPub),
    })
  ).id;

  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: paraPub,
    modelId: MODEL,
    vector: fakeVector(1),
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: paraSecret,
    modelId: MODEL,
    vector: fakeVector(2),
  });

  // Citation telemetry: paraPub cited twice, paraSecret once — for the
  // citation-frequency no-leak tests (counts must be access-gated).
  await store.insertCitationEvents(ctx, [
    { paragraphId: paraPub, documentId: doc },
    { paragraphId: paraPub, documentId: doc },
    { paragraphId: paraSecret, documentId: docSecret },
  ]);

  // Review-queue suggestions (P6a): one PUB-tagged, one SECRET-tagged, each
  // carrying its TARGET entity's access tags so the queue read is access-gated.
  const reviewPub = (
    await store.enqueueReviewItem(ctx, {
      targetKind: 'entity',
      targetId: entityPub,
      proposedChange: { patch: { properties: { name: 'corrected pub' } } },
      accessTags: PUB,
      note: 'suggested pub correction',
    })
  ).id;
  const reviewSecret = (
    await store.enqueueReviewItem(ctx, {
      targetKind: 'entity',
      targetId: entitySecret,
      proposedChange: { patch: { properties: { name: 'corrected secret' } } },
      accessTags: SECRET,
    })
  ).id;

  return {
    doc,
    docSecret,
    pubSha,
    secretSha,
    pubExternal,
    secretExternal,
    paraPub,
    paraSecret,
    ext,
    entityPub,
    entitySecret,
    entityDeleted,
    edgePub,
    reviewPub,
    reviewSecret,
  };
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

beforeEach(async () => {
  // NOTE: embeddings must be truncated explicitly — target_id is polymorphic
  // (no FK to paragraphs), so truncating paragraphs does NOT cascade to it.
  // Omitting it lets stale embeddings accumulate across tests.
  // citation_events is named explicitly too: it is cleaned via its CASCADE FKs
  // today, but naming it keeps the reset robust if those FKs ever change.
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents, embeddings,
    extractor_versions, audit_events, llm_calls, connector_state, citation_events,
    review_queue
    RESTART IDENTITY CASCADE`);
  a = await seed(TENANT_A, 'a');
  b = await seed(TENANT_B, 'b');
});

// ---------------------------------------------------------------------------
// Entity-returning readers × {tag positive/negative, empty, tenant, soft-delete}
// ---------------------------------------------------------------------------
describe('reader: entity visibility', () => {
  it('getEntity: pub caller sees pub entity, not secret entity', async () => {
    expect(await store.getEntity(readCtx(TENANT_A, PUB), a.entityPub)).not.toBeNull();
    expect(await store.getEntity(readCtx(TENANT_A, PUB), a.entitySecret)).toBeNull();
  });
  it('getEntity: secret caller sees secret entity', async () => {
    expect(await store.getEntity(readCtx(TENANT_A, SECRET), a.entitySecret)).not.toBeNull();
  });
  it('getEntity: empty tags see nothing', async () => {
    expect(await store.getEntity(readCtx(TENANT_A, EMPTY), a.entityPub)).toBeNull();
  });
  it('getEntity: wrong tag sees nothing', async () => {
    expect(await store.getEntity(readCtx(TENANT_A, WRONG), a.entityPub)).toBeNull();
  });
  it('getEntity: soft-deleted entity invisible even with right tag', async () => {
    expect(await store.getEntity(readCtx(TENANT_A, PUB), a.entityDeleted)).toBeNull();
  });
  it('getEntity: tenant B cannot see tenant A entity with matching tags', async () => {
    expect(await store.getEntity(readCtx(TENANT_B, BOTH), a.entityPub)).toBeNull();
  });

  it('getEntitiesByIds: filters to visible subset silently', async () => {
    const res = await store.getEntitiesByIds(readCtx(TENANT_A, PUB), [
      a.entityPub,
      a.entitySecret,
      a.entityDeleted,
    ]);
    expect(res.map((e) => e.id)).toEqual([a.entityPub]);
  });
  it('getEntitiesByIds: empty tags return nothing', async () => {
    const res = await store.getEntitiesByIds(readCtx(TENANT_A, EMPTY), [
      a.entityPub,
      a.entitySecret,
    ]);
    expect(res).toEqual([]);
  });
  it('getEntitiesByIds: cross-tenant ids filtered out', async () => {
    const res = await store.getEntitiesByIds(readCtx(TENANT_A, BOTH), [a.entityPub, b.entityPub]);
    expect(res.map((e) => e.id)).toEqual([a.entityPub]);
  });

  it('findEntities: pub caller gets only visible, non-deleted, own-tenant', async () => {
    const page = await store.findEntities(readCtx(TENANT_A, PUB), {});
    const ids = page.items.map((e) => e.id);
    expect(ids).toContain(a.entityPub);
    expect(ids).not.toContain(a.entitySecret);
    expect(ids).not.toContain(a.entityDeleted);
    expect(ids).not.toContain(b.entityPub);
  });
  it('findEntities: empty tags return nothing', async () => {
    const page = await store.findEntities(readCtx(TENANT_A, EMPTY), {});
    expect(page.items).toEqual([]);
  });
  it('findEntities propertyEquals (M1.2 key-gather): rows AND count are visible-scoped — no out-of-clearance leak', async () => {
    // entitySecret has properties.name === 'secret' and is tagged SECRET. A
    // key-gather by a caller without the SECRET tag must return nothing AND a
    // count of 0 — "matches 1, you see 0" would leak that the record exists.
    const asPub = await store.findEntities(readCtx(TENANT_A, PUB), {
      propertyEquals: { property: 'name', value: 'secret' },
    });
    expect(asPub.items).toEqual([]);
    expect(asPub.total).toBe(0);
    const asBoth = await store.findEntities(readCtx(TENANT_A, BOTH), {
      propertyEquals: { property: 'name', value: 'secret' },
    });
    expect(asBoth.items.map((e) => e.id)).toEqual([a.entitySecret]);
    expect(asBoth.total).toBe(1);
  });

  it('findEntitiesByParagraphIds: pub caller sees only pub entity from the paragraph', async () => {
    const res = await store.findEntitiesByParagraphIds(readCtx(TENANT_A, PUB), [a.paraPub]);
    const ids = res.map((e) => e.id);
    expect(ids).toContain(a.entityPub);
    expect(ids).not.toContain(a.entitySecret);
    expect(ids).not.toContain(a.entityDeleted);
  });
  it('findEntitiesByParagraphIds: empty tags return nothing', async () => {
    expect(await store.findEntitiesByParagraphIds(readCtx(TENANT_A, EMPTY), [a.paraPub])).toEqual(
      [],
    );
  });
  it('findEntitiesByParagraphIds: cross-tenant paragraph yields nothing', async () => {
    expect(await store.findEntitiesByParagraphIds(readCtx(TENANT_A, BOTH), [b.paraPub])).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------
describe('reader: edge visibility', () => {
  it('getEdge: pub caller sees pub edge', async () => {
    expect(await store.getEdge(readCtx(TENANT_A, PUB), a.edgePub)).not.toBeNull();
  });
  it('getEdge: empty tags see nothing', async () => {
    expect(await store.getEdge(readCtx(TENANT_A, EMPTY), a.edgePub)).toBeNull();
  });
  it('getEdge: wrong tag sees nothing', async () => {
    expect(await store.getEdge(readCtx(TENANT_A, WRONG), a.edgePub)).toBeNull();
  });
  it('getEdge: tenant B cannot see tenant A edge', async () => {
    expect(await store.getEdge(readCtx(TENANT_B, BOTH), a.edgePub)).toBeNull();
  });
  it('findEdges: pub caller gets own-tenant visible edges only', async () => {
    const page = await store.findEdges(readCtx(TENANT_A, PUB), {});
    const ids = page.items.map((e) => e.id);
    expect(ids).toContain(a.edgePub);
    expect(ids).not.toContain(b.edgePub);
  });
  it('findEdges: empty tags return nothing', async () => {
    expect((await store.findEdges(readCtx(TENANT_A, EMPTY), {})).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Documents & paragraphs
// ---------------------------------------------------------------------------
describe('reader: document & paragraph visibility', () => {
  it('getDocument: tag + tenant enforced', async () => {
    expect(await store.getDocument(readCtx(TENANT_A, PUB), a.doc)).not.toBeNull();
    expect(await store.getDocument(readCtx(TENANT_A, PUB), a.docSecret)).toBeNull();
    expect(await store.getDocument(readCtx(TENANT_A, EMPTY), a.doc)).toBeNull();
    expect(await store.getDocument(readCtx(TENANT_B, BOTH), a.doc)).toBeNull();
  });
  it('getParagraph: tag + tenant enforced', async () => {
    expect(await store.getParagraph(readCtx(TENANT_A, PUB), a.paraPub)).not.toBeNull();
    expect(await store.getParagraph(readCtx(TENANT_A, PUB), a.paraSecret)).toBeNull();
    expect(await store.getParagraph(readCtx(TENANT_A, EMPTY), a.paraPub)).toBeNull();
    expect(await store.getParagraph(readCtx(TENANT_B, BOTH), a.paraPub)).toBeNull();
  });
  it('findParagraphsByDocument: only visible paragraphs of own tenant', async () => {
    const res = await store.findParagraphsByDocument(readCtx(TENANT_A, PUB), a.doc);
    expect(res.map((p) => p.id)).toEqual([a.paraPub]);
    expect(await store.findParagraphsByDocument(readCtx(TENANT_A, EMPTY), a.doc)).toEqual([]);
  });

  it('getDocumentsByIds: filters to the visible subset silently', async () => {
    const res = await store.getDocumentsByIds(readCtx(TENANT_A, PUB), [a.doc, a.docSecret]);
    expect(res.map((d) => d.id)).toEqual([a.doc]);
  });
  it('getDocumentsByIds: empty tags return nothing', async () => {
    expect(await store.getDocumentsByIds(readCtx(TENANT_A, EMPTY), [a.doc, a.docSecret])).toEqual(
      [],
    );
  });
  it('getDocumentsByIds: cross-tenant ids filtered out', async () => {
    const res = await store.getDocumentsByIds(readCtx(TENANT_A, BOTH), [a.doc, b.doc]);
    expect(res.map((d) => d.id)).toEqual([a.doc]);
  });

  it('findDocuments: lists + counts only the visible, own-tenant subset', async () => {
    const pub = await store.findDocuments(readCtx(TENANT_A, PUB), {});
    expect(pub.items.map((d) => d.id)).toEqual([a.doc]); // not docSecret, not B's
    expect(pub.total).toBe(1);
  });
  it('findDocuments: a caller with both tags sees both own-tenant docs (not B)', async () => {
    const both = await store.findDocuments(readCtx(TENANT_A, BOTH), {});
    expect(both.items.map((d) => d.id).sort()).toEqual([a.doc, a.docSecret].sort());
    expect(both.total).toBe(2);
  });
  it('findDocuments: empty tags return nothing (total 0)', async () => {
    const none = await store.findDocuments(readCtx(TENANT_A, EMPTY), {});
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('getParagraphsByIds: filters to the visible subset silently', async () => {
    const res = await store.getParagraphsByIds(readCtx(TENANT_A, PUB), [a.paraPub, a.paraSecret]);
    expect(res.map((p) => p.id)).toEqual([a.paraPub]);
  });
  it('getParagraphsByIds: empty tags return nothing', async () => {
    expect(
      await store.getParagraphsByIds(readCtx(TENANT_A, EMPTY), [a.paraPub, a.paraSecret]),
    ).toEqual([]);
  });
  it('getParagraphsByIds: cross-tenant ids filtered out', async () => {
    const res = await store.getParagraphsByIds(readCtx(TENANT_A, BOTH), [a.paraPub, b.paraPub]);
    expect(res.map((p) => p.id)).toEqual([a.paraPub]);
  });

  // findDocumentByHash is access-tag-filtered (readFilters) even though its
  // primary caller is the bypass idempotency check — a regular caller (e.g. a
  // future "already ingested?" UI probe) must not learn that a restricted
  // document with a known hash exists.
  it('findDocumentByHash: pub caller finds a pub document by hash', async () => {
    const found = await store.findDocumentByHash(readCtx(TENANT_A, PUB), a.pubSha);
    expect(found?.id).toBe(a.doc);
  });
  it('findDocumentByHash: pub caller does NOT find a secret document by hash', async () => {
    expect(await store.findDocumentByHash(readCtx(TENANT_A, PUB), a.secretSha)).toBeNull();
  });
  it('findDocumentByHash: empty tags find nothing', async () => {
    expect(await store.findDocumentByHash(readCtx(TENANT_A, EMPTY), a.pubSha)).toBeNull();
  });
  it('findDocumentByHash: tenant B cannot find tenant A document by hash', async () => {
    expect(await store.findDocumentByHash(readCtx(TENANT_B, BOTH), a.pubSha)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Duplicate links (P3a) — findDocumentFingerprints + findDuplicatesForDocument.
// A near/semantic link must NEVER reveal a document the caller cannot see.
// ---------------------------------------------------------------------------
describe('reader: duplicate links visibility (P3a)', () => {
  // --- findDocumentFingerprints: access-filtered like every read ---
  it('findDocumentFingerprints: pub caller sees only the pub fingerprint', async () => {
    const fps = await store.findDocumentFingerprints(readCtx(TENANT_A, PUB), { limit: 100 });
    const ids = fps.map((f) => f.id);
    expect(ids).toContain(a.doc);
    expect(ids).not.toContain(a.docSecret); // secret fingerprint not visible
    expect(ids).not.toContain(b.doc); // cross-tenant
  });
  it('findDocumentFingerprints: empty tags return nothing', async () => {
    expect(await store.findDocumentFingerprints(readCtx(TENANT_A, EMPTY), { limit: 100 })).toEqual(
      [],
    );
  });
  it('findDocumentFingerprints: bypass sees the full tenant corpus (both docs)', async () => {
    const fps = await store.findDocumentFingerprints(bypassCtx(TENANT_A), { limit: 100 });
    const ids = fps.map((f) => f.id);
    expect(ids).toContain(a.doc);
    expect(ids).toContain(a.docSecret);
    expect(ids).not.toContain(b.doc); // bypass drops tags, NEVER the tenant
  });

  // --- findDuplicatesForDocument: BOTH endpoints must be visible ---
  it('returns the link only when BOTH endpoints are visible (caller has both tags)', async () => {
    const links = await store.findDuplicatesForDocument(readCtx(TENANT_A, BOTH), a.doc);
    expect(links).toHaveLength(1);
    expect(links[0]?.duplicateOfDocumentId).toBe(a.docSecret);
    expect(links[0]?.method).toBe('near');
  });
  it('NO-LEAK: a pub caller querying the pub doc gets nothing (secret counterpart hidden)', async () => {
    // The link points pub-doc → secret-doc. A caller who can see the pub doc but
    // NOT the secret one must not learn the secret doc exists via the link.
    expect(await store.findDuplicatesForDocument(readCtx(TENANT_A, PUB), a.doc)).toEqual([]);
  });
  it('NO-LEAK: a secret caller querying the secret doc gets nothing (pub counterpart hidden)', async () => {
    // Symmetric: the secret caller can see docSecret but not the pub endpoint.
    expect(await store.findDuplicatesForDocument(readCtx(TENANT_A, SECRET), a.docSecret)).toEqual(
      [],
    );
  });
  it('empty tags return nothing', async () => {
    expect(await store.findDuplicatesForDocument(readCtx(TENANT_A, EMPTY), a.doc)).toEqual([]);
  });
  it('tenant B cannot see tenant A duplicate links', async () => {
    expect(await store.findDuplicatesForDocument(readCtx(TENANT_B, BOTH), a.doc)).toEqual([]);
  });
  it('the link is bidirectional: querying the secret endpoint with both tags also returns it', async () => {
    const links = await store.findDuplicatesForDocument(readCtx(TENANT_A, BOTH), a.docSecret);
    expect(links).toHaveLength(1);
    expect(links[0]?.documentId).toBe(a.doc);
  });
});

// ---------------------------------------------------------------------------
// Versioning reads/writes (P3a) — findLatestLiveDocumentByExternalId + supersede.
// The lookup is access-tag filtered; the writer is tenant-scoped.
// ---------------------------------------------------------------------------
describe('reader/writer: versioning (P3a)', () => {
  it('findLatestLiveDocumentByExternalId: pub caller finds the pub document', async () => {
    const found = await store.findLatestLiveDocumentByExternalId(readCtx(TENANT_A, PUB), {
      connectorPackage: CONN,
      externalId: a.pubExternal,
    });
    expect(found?.id).toBe(a.doc);
  });
  it('findLatestLiveDocumentByExternalId: pub caller does NOT find the secret document', async () => {
    expect(
      await store.findLatestLiveDocumentByExternalId(readCtx(TENANT_A, PUB), {
        connectorPackage: CONN,
        externalId: a.secretExternal,
      }),
    ).toBeNull();
  });
  it('findLatestLiveDocumentByExternalId: empty tags find nothing', async () => {
    expect(
      await store.findLatestLiveDocumentByExternalId(readCtx(TENANT_A, EMPTY), {
        connectorPackage: CONN,
        externalId: a.pubExternal,
      }),
    ).toBeNull();
  });
  it('findLatestLiveDocumentByExternalId: tenant B cannot find tenant A document', async () => {
    expect(
      await store.findLatestLiveDocumentByExternalId(readCtx(TENANT_B, BOTH), {
        connectorPackage: CONN,
        externalId: a.pubExternal,
      }),
    ).toBeNull();
  });
  it('findLatestLiveDocumentByExternalId: a superseded version is NOT returned (only the live one)', async () => {
    // Supersede the pub doc → it is no longer the live version, so the lookup
    // returns null (there is no other live version under this externalId).
    await store.supersedeDocument(writeCtx(TENANT_A), a.doc, { validTo: new Date() });
    expect(
      await store.findLatestLiveDocumentByExternalId(readCtx(TENANT_A, PUB), {
        connectorPackage: CONN,
        externalId: a.pubExternal,
      }),
    ).toBeNull();
    // …but the superseded document itself is STILL retrievable (never dropped).
    const stillThere = await store.getDocument(readCtx(TENANT_A, PUB), a.doc);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.validTo).not.toBeNull();
  });
  it('supersedeDocument: tenant B cannot supersede tenant A document (write tenant-scoped)', async () => {
    await store.supersedeDocument(writeCtx(TENANT_B), a.doc, { validTo: new Date() });
    const unchanged = await store.getDocument(readCtx(TENANT_A, PUB), a.doc);
    expect(unchanged?.validTo).toBeNull(); // tenant B's write did not touch tenant A's row
  });
});

// ---------------------------------------------------------------------------
// findParagraphsPendingExtraction (access-tag filtered like every read)
// ---------------------------------------------------------------------------
describe('reader: findParagraphsPendingExtraction visibility', () => {
  // No entity was extracted under this schema, so every *visible* paragraph
  // is pending; the access filter must still apply.
  const UNKNOWN_SCHEMA = 'no-such-schema-hash';
  const currentSchema = (t: TenantId) => `h-${t}`;

  it('pub caller sees only the pub paragraph as pending, never the secret one', async () => {
    const res = await store.findParagraphsPendingExtraction(readCtx(TENANT_A, PUB), {
      schemaHash: UNKNOWN_SCHEMA,
    });
    const ids = res.map((p) => p.id);
    expect(ids).toContain(a.paraPub);
    expect(ids).not.toContain(a.paraSecret);
  });
  it('empty tags return nothing', async () => {
    expect(
      await store.findParagraphsPendingExtraction(readCtx(TENANT_A, EMPTY), {
        schemaHash: UNKNOWN_SCHEMA,
      }),
    ).toEqual([]);
  });
  it('does not surface another tenants pending paragraphs', async () => {
    const res = await store.findParagraphsPendingExtraction(readCtx(TENANT_B, BOTH), {
      schemaHash: UNKNOWN_SCHEMA,
    });
    const ids = res.map((p) => p.id);
    expect(ids).not.toContain(a.paraPub);
    expect(ids).not.toContain(a.paraSecret);
  });
  it('excludes a paragraph already extracted under the current schema', async () => {
    // paraPub has live entities under h-TENANT_A; paraSecret has none.
    const pub = await store.findParagraphsPendingExtraction(readCtx(TENANT_A, PUB), {
      schemaHash: currentSchema(TENANT_A),
    });
    expect(pub.map((p) => p.id)).not.toContain(a.paraPub);
    const secret = await store.findParagraphsPendingExtraction(readCtx(TENANT_A, SECRET), {
      schemaHash: currentSchema(TENANT_A),
    });
    expect(secret.map((p) => p.id)).toContain(a.paraSecret);
  });
});

// ---------------------------------------------------------------------------
// getNeighbours triple-filter
// ---------------------------------------------------------------------------
describe('reader: getNeighbours triple-filter', () => {
  it('omits the neighbour when the far endpoint is invisible to the caller', async () => {
    // edgePub (pub) connects entityPub → entitySecret. A pub caller sees the
    // edge and source but NOT the secret far endpoint, so it is omitted.
    const out = await store.getNeighbours(readCtx(TENANT_A, PUB), a.entityPub, {
      direction: 'both',
    });
    expect(out.entities.map((e) => e.id)).not.toContain(a.entitySecret);
  });
  it('a both-tag caller sees the far endpoint', async () => {
    const out = await store.getNeighbours(readCtx(TENANT_A, BOTH), a.entityPub, {
      direction: 'both',
    });
    expect(out.entities.map((e) => e.id)).toContain(a.entitySecret);
  });
  it('empty tags: no neighbours', async () => {
    const out = await store.getNeighbours(readCtx(TENANT_A, EMPTY), a.entityPub, {
      direction: 'both',
    });
    expect(out.entities).toEqual([]);
    expect(out.edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchByVector
// ---------------------------------------------------------------------------
describe('reader: searchByVector', () => {
  it('returns only paragraphs whose tags the caller holds', async () => {
    const res = await store.searchByVector(readCtx(TENANT_A, PUB), {
      modelId: MODEL,
      k: 10,
      queryVector: fakeVector(1),
    });
    const ids = res.map((r) => r.targetId);
    expect(ids).toContain(a.paraPub);
    expect(ids).not.toContain(a.paraSecret);
  });
  it('empty tags return nothing', async () => {
    const res = await store.searchByVector(readCtx(TENANT_A, EMPTY), {
      modelId: MODEL,
      k: 10,
      queryVector: fakeVector(1),
    });
    expect(res).toEqual([]);
  });
  it('does not return other tenants paragraphs', async () => {
    const res = await store.searchByVector(readCtx(TENANT_A, BOTH), {
      modelId: MODEL,
      k: 50,
      queryVector: fakeVector(1),
    });
    const ids = res.map((r) => r.targetId);
    expect(ids).not.toContain(b.paraPub);
    expect(ids).not.toContain(b.paraSecret);
  });
  it('soft-deleting an entity does not hide its source paragraph from search', async () => {
    // The embedding-soft-delete contract (a soft-deleted *paragraph* hides its
    // embedding) is covered structurally in graph-store.int.test.ts. Here we
    // pin the adjacent behaviour: soft-deleting an entity extracted from a
    // paragraph leaves that paragraph's embedding searchable (entities and
    // paragraphs are independent rows).
    await store.softDeleteEntity(writeCtx(TENANT_A), a.entityPub);
    const res = await store.searchByVector(readCtx(TENANT_A, PUB), {
      modelId: MODEL,
      k: 10,
      queryVector: fakeVector(1),
    });
    expect(res.map((r) => r.targetId)).toContain(a.paraPub);
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingsByTargets (P2-3) — the semantic-dedup vector read. Returns the
// STORED VECTORS for requested targets, so a dropped filter here hands a
// caller the raw embedding of content outside their clearance. Same access
// posture as searchByVector: tenant + model + tag overlap (FALSE for an empty
// caller tag set) + soft-delete exclusion via the underlying paragraph.
// ---------------------------------------------------------------------------
describe('reader: getEmbeddingsByTargets (P2-3)', () => {
  const bothTargets = () => [a.paraPub as string, a.paraSecret as string];

  it('returns only embeddings whose tags the caller holds', async () => {
    const res = await store.getEmbeddingsByTargets(readCtx(TENANT_A, PUB), {
      targetKind: 'paragraph',
      targetIds: bothTargets(),
      modelId: MODEL,
    });
    const ids = res.map((e) => e.targetId);
    expect(ids).toContain(a.paraPub);
    expect(ids).not.toContain(a.paraSecret); // requested by id, withheld by tag
  });

  it('a higher-clearance caller sees both embeddings', async () => {
    const res = await store.getEmbeddingsByTargets(readCtx(TENANT_A, BOTH), {
      targetKind: 'paragraph',
      targetIds: bothTargets(),
      modelId: MODEL,
    });
    expect(res.map((e) => e.targetId).sort()).toEqual([a.paraPub, a.paraSecret].sort());
  });

  it('empty tags return nothing (fail-closed, never "no filter")', async () => {
    const res = await store.getEmbeddingsByTargets(readCtx(TENANT_A, EMPTY), {
      targetKind: 'paragraph',
      targetIds: bothTargets(),
      modelId: MODEL,
    });
    expect(res).toEqual([]);
  });

  it("does not return another tenant's embeddings (even passing its ids)", async () => {
    const res = await store.getEmbeddingsByTargets(readCtx(TENANT_A, BOTH), {
      targetKind: 'paragraph',
      targetIds: [b.paraPub as string, b.paraSecret as string],
      modelId: MODEL,
    });
    expect(res).toEqual([]);
  });

  it("a soft-deleted paragraph's embedding is excluded", async () => {
    // No public writer soft-deletes a single paragraph today — stamp deletedAt
    // directly to exercise the read-side exclusion (fixture manipulation only;
    // the read under test still goes through the store).
    await db
      .update(paragraphs)
      .set({ deletedAt: new Date() })
      .where(sql`${paragraphs.id} = ${a.paraPub}`);
    const res = await store.getEmbeddingsByTargets(readCtx(TENANT_A, BOTH), {
      targetKind: 'paragraph',
      targetIds: bothTargets(),
      modelId: MODEL,
    });
    const ids = res.map((e) => e.targetId);
    expect(ids).not.toContain(a.paraPub); // hidden via the underlying paragraph
    expect(ids).toContain(a.paraSecret); // the live one still returns
  });

  it('an empty target list returns empty (no scan)', async () => {
    expect(
      await store.getEmbeddingsByTargets(readCtx(TENANT_A, BOTH), {
        targetKind: 'paragraph',
        targetIds: [],
        modelId: MODEL,
      }),
    ).toEqual([]);
  });

  it('bypass sees both embeddings (tenant still enforced) and writes a log row', async () => {
    const before = await bypassRowCount();
    const res = await store.getEmbeddingsByTargets(bypassCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetIds: bothTargets(),
      modelId: MODEL,
    });
    expect(res.map((e) => e.targetId).sort()).toEqual([a.paraPub, a.paraSecret].sort());
    expect(await bypassRowCount()).toBe(before + 1);
    // Tenant isolation survives bypass: another tenant's ids return nothing.
    const cross = await store.getEmbeddingsByTargets(bypassCtx(TENANT_A), {
      targetKind: 'paragraph',
      targetIds: [b.paraPub as string],
      modelId: MODEL,
    });
    expect(cross).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchByKeyword — same access-tag + tenant + soft-delete filter as every read.
// Both fixture paragraphs contain the word "paragraph", so a keyword query for it
// matches both rows lexically; only the tag filter keeps the secret one hidden.
// ---------------------------------------------------------------------------
describe('reader: searchByKeyword', () => {
  it('returns only paragraphs whose tags the caller holds', async () => {
    const res = await store.searchByKeyword(readCtx(TENANT_A, PUB), { query: 'paragraph', k: 10 });
    const ids = res.map((r) => r.targetId);
    expect(ids).toContain(a.paraPub);
    expect(ids).not.toContain(a.paraSecret); // matches lexically, withheld by tag
  });
  it('empty tags return nothing', async () => {
    const res = await store.searchByKeyword(readCtx(TENANT_A, EMPTY), {
      query: 'paragraph',
      k: 10,
    });
    expect(res).toEqual([]);
  });
  it('an empty / whitespace query returns nothing (no scan)', async () => {
    expect(await store.searchByKeyword(readCtx(TENANT_A, PUB), { query: '   ', k: 10 })).toEqual(
      [],
    );
  });
  it('does not return other tenants paragraphs', async () => {
    const res = await store.searchByKeyword(readCtx(TENANT_A, BOTH), { query: 'paragraph', k: 50 });
    const ids = res.map((r) => r.targetId);
    expect(ids).not.toContain(b.paraPub);
    expect(ids).not.toContain(b.paraSecret);
  });
});

// ---------------------------------------------------------------------------
// countCitationsByParagraph — the citation-frequency read path. Access-gated by
// a join to paragraphs: a count is returned ONLY for a paragraph the caller can
// see. paraPub was cited twice, paraSecret once (seeded above).
// ---------------------------------------------------------------------------
describe('reader: countCitationsByParagraph', () => {
  it('returns counts only for paragraphs whose tags the caller holds', async () => {
    const counts = await store.countCitationsByParagraph(readCtx(TENANT_A, PUB), [
      a.paraPub,
      a.paraSecret,
    ]);
    expect(counts.get(a.paraPub)).toBe(2);
    expect(counts.has(a.paraSecret)).toBe(false); // cited once, but withheld by tag
  });
  it('a higher-clearance caller sees both counts', async () => {
    const counts = await store.countCitationsByParagraph(readCtx(TENANT_A, BOTH), [
      a.paraPub,
      a.paraSecret,
    ]);
    expect(counts.get(a.paraPub)).toBe(2);
    expect(counts.get(a.paraSecret)).toBe(1);
  });
  it('empty tags return no counts', async () => {
    const counts = await store.countCitationsByParagraph(readCtx(TENANT_A, EMPTY), [
      a.paraPub,
      a.paraSecret,
    ]);
    expect(counts.size).toBe(0);
  });
  it('an empty id list returns an empty map (no scan)', async () => {
    expect((await store.countCitationsByParagraph(readCtx(TENANT_A, BOTH), [])).size).toBe(0);
  });
  it('does not count another tenants citations (even passing its ids)', async () => {
    const counts = await store.countCitationsByParagraph(readCtx(TENANT_A, BOTH), [
      b.paraPub,
      b.paraSecret,
    ]);
    expect(counts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review queue (P6a) — the NEW protected read. A steward must NEVER see a
// queued correction for a target outside their clearance: the list and the
// single-item read apply the SAME access-tag overlap as every content read,
// plus tenant isolation. (Cross-tag + cross-tenant no-leak.)
// ---------------------------------------------------------------------------
describe('reader: review-queue visibility (P6a)', () => {
  it('findPendingReviewItems: pub caller sees ONLY the pub-tagged item', async () => {
    const items = await store.findPendingReviewItems(readCtx(TENANT_A, PUB));
    expect(items.map((i) => i.id)).toEqual([a.reviewPub]);
  });
  it('findPendingReviewItems: secret caller sees ONLY the secret-tagged item', async () => {
    const items = await store.findPendingReviewItems(readCtx(TENANT_A, SECRET));
    expect(items.map((i) => i.id)).toEqual([a.reviewSecret]);
  });
  it('findPendingReviewItems: BOTH-tag caller sees both items', async () => {
    const items = await store.findPendingReviewItems(readCtx(TENANT_A, BOTH));
    expect([...items.map((i) => i.id)].sort()).toEqual([a.reviewPub, a.reviewSecret].sort());
  });
  it('findPendingReviewItems: empty tags see NOTHING (fail-closed)', async () => {
    expect(await store.findPendingReviewItems(readCtx(TENANT_A, EMPTY))).toEqual([]);
  });
  it('findPendingReviewItems: wrong tag sees nothing', async () => {
    expect(await store.findPendingReviewItems(readCtx(TENANT_A, WRONG))).toEqual([]);
  });
  it('findPendingReviewItems: tenant B never sees tenant A items, only its own (cross-tenant)', async () => {
    const items = await store.findPendingReviewItems(readCtx(TENANT_B, BOTH));
    expect([...items.map((i) => i.id)].sort()).toEqual([b.reviewPub, b.reviewSecret].sort());
    expect(items.some((i) => i.id === a.reviewPub || i.id === a.reviewSecret)).toBe(false);
  });
  it('getReviewItem: pub caller sees the pub item, NOT the secret item', async () => {
    expect(await store.getReviewItem(readCtx(TENANT_A, PUB), a.reviewPub)).not.toBeNull();
    expect(await store.getReviewItem(readCtx(TENANT_A, PUB), a.reviewSecret)).toBeNull();
  });
  it('getReviewItem: empty tags see nothing', async () => {
    expect(await store.getReviewItem(readCtx(TENANT_A, EMPTY), a.reviewPub)).toBeNull();
  });
  it('getReviewItem: tenant B cannot fetch a tenant A item even with matching tags', async () => {
    expect(await store.getReviewItem(readCtx(TENANT_B, BOTH), a.reviewPub)).toBeNull();
  });
  it('getReviewItem returns the opaque proposed_change + target verbatim (generic shape)', async () => {
    const item = await store.getReviewItem(readCtx(TENANT_A, PUB), a.reviewPub);
    expect(item?.targetKind).toBe('entity');
    expect(item?.targetId).toBe(a.entityPub);
    expect(item?.proposedChange).toEqual({ patch: { properties: { name: 'corrected pub' } } });
    expect(item?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Tenant-only readers (no access tags)
// ---------------------------------------------------------------------------
describe('reader: tenant-scoped operational reads', () => {
  it('findExtractorVersion: scoped to tenant', async () => {
    const key = {
      configurationId: 'cfg',
      schemaHash: `h-${TENANT_A}`,
      promptHash: 'p',
      modelId: MODEL,
    };
    expect(await store.findExtractorVersion(readCtx(TENANT_A, EMPTY), key)).not.toBeNull();
    expect(await store.findExtractorVersion(readCtx(TENANT_B, EMPTY), key)).toBeNull();
  });
  it('findRecentQueryEvents: tenant-scoped (a tenant never sees another tenant query telemetry)', async () => {
    await store.insertQueryEvent(writeCtx(TENANT_A), {
      actor: ACTOR,
      status: 'answered',
      resultCount: 2,
      latencyMs: 5,
    });
    await store.insertQueryEvent(writeCtx(TENANT_A), {
      actor: ACTOR,
      status: 'no_evidence',
      resultCount: 0,
      latencyMs: 3,
    });
    await store.insertQueryEvent(writeCtx(TENANT_B), {
      actor: ACTOR,
      status: 'answered',
      resultCount: 9,
      latencyMs: 9,
    });
    const a = await store.findRecentQueryEvents(readCtx(TENANT_A, EMPTY), { limit: 10 });
    expect(a).toHaveLength(2); // only TENANT_A's, never TENANT_B's
    expect(a.every((e) => e.resultCount !== 9)).toBe(true);
    const b = await store.findRecentQueryEvents(readCtx(TENANT_B, EMPTY), { limit: 10 });
    expect(b).toHaveLength(1);
  });
  it('countQueryEvents: tenant + actor scoped (never counts another tenant/actor; respects since)', async () => {
    // The shared test DB already holds rows from earlier `it`s, so assert on the
    // DELTA from a baseline rather than absolute counts. A dedicated actor (used
    // by no other test) makes the actor-scoping assertion exact regardless of
    // prior state. `since` is far in the past so it never races the DB clock.
    const SOLO = asActorId('perm-matrix-count-solo');
    const since = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);
    const soloCtx = (tenantId: TenantId): ReadContext => ({
      ...readCtx(tenantId, EMPTY),
      actor: SOLO,
    });

    const baseA = await store.countQueryEvents(readCtx(TENANT_A, EMPTY), { since, byActor: false });
    const baseB = await store.countQueryEvents(readCtx(TENANT_B, EMPTY), { since, byActor: false });

    // TENANT_A: 2 by SOLO. TENANT_B: 1 by SOLO.
    await store.insertQueryEvent(
      { tenantId: TENANT_A, actor: SOLO },
      { actor: SOLO, status: 'answered', resultCount: 1, latencyMs: 1 },
    );
    await store.insertQueryEvent(
      { tenantId: TENANT_A, actor: SOLO },
      { actor: SOLO, status: 'answered', resultCount: 1, latencyMs: 1 },
    );
    await store.insertQueryEvent(
      { tenantId: TENANT_B, actor: SOLO },
      { actor: SOLO, status: 'answered', resultCount: 1, latencyMs: 1 },
    );

    // Tenant-wide for A grew by exactly 2; B by exactly 1 (no cross-tenant bleed).
    expect(await store.countQueryEvents(readCtx(TENANT_A, EMPTY), { since, byActor: false })).toBe(
      baseA + 2,
    );
    expect(await store.countQueryEvents(readCtx(TENANT_B, EMPTY), { since, byActor: false })).toBe(
      baseB + 1,
    );
    // Actor-scoped to SOLO: exactly its own 2 in A, 1 in B (no other test uses it).
    expect(await store.countQueryEvents(soloCtx(TENANT_A), { since, byActor: true })).toBe(2);
    expect(await store.countQueryEvents(soloCtx(TENANT_B), { since, byActor: true })).toBe(1);
    // `since` in the future excludes everything.
    expect(
      await store.countQueryEvents(readCtx(TENANT_A, EMPTY), { since: future, byActor: false }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
describe('writes: tenant isolation + soft-delete cascade', () => {
  it('inserted entity carries the write-context tenant', async () => {
    const e = await store.getEntity(bypassCtx(TENANT_A), a.entityPub);
    expect(e?.tenantId).toBe(TENANT_A);
  });
  it('soft-deleting an entity cascades to its incident edges', async () => {
    await store.softDeleteEntity(writeCtx(TENANT_A), a.entityPub);
    // edgePub was incident to entityPub → now soft-deleted, invisible to reads.
    expect(await store.getEdge(readCtx(TENANT_A, BOTH), a.edgePub)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INTERNAL_BYPASS
// ---------------------------------------------------------------------------
describe('INTERNAL_BYPASS', () => {
  it('drops the access-tag filter (sees a secret entity a pub caller cannot)', async () => {
    expect(await store.getEntity(readCtx(TENANT_A, PUB), a.entitySecret)).toBeNull();
    expect(await store.getEntity(bypassCtx(TENANT_A), a.entitySecret)).not.toBeNull();
  });
  it('does NOT bypass tenant isolation', async () => {
    expect(await store.getEntity(bypassCtx(TENANT_B), a.entityPub)).toBeNull();
  });
  it('writes an internal_bypass_log row', async () => {
    const before = await bypassRowCount();
    await store.getEntity(bypassCtx(TENANT_A), a.entityPub);
    expect(await bypassRowCount()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// CATASTROPHIC: cross-tenant contamination via vector search
// ---------------------------------------------------------------------------
describe('CATASTROPHIC — cross-tenant contamination via vector search', () => {
  it('a tenant-A query matching content in BOTH tenants returns only tenant-A paragraphs', async () => {
    // Both tenants were seeded with the SAME vectors (fakeVector(1)/(2)), so a
    // tenant-A query vector matches tenant-B paragraphs just as strongly. The
    // tenant filter must still exclude every tenant-B row.
    const res = await store.searchByVector(readCtx(TENANT_A, BOTH), {
      modelId: MODEL,
      k: 100,
      queryVector: fakeVector(1),
    });
    const ids = new Set(res.map((r) => r.targetId));
    expect(ids.has(a.paraPub)).toBe(true);
    // Not one tenant-B paragraph, despite identical vectors:
    expect(ids.has(b.paraPub)).toBe(false);
    expect(ids.has(b.paraSecret)).toBe(false);
    for (const r of res) {
      const para = await store.getParagraph(bypassCtx(TENANT_A), r.targetId as ParagraphId);
      expect(para?.tenantId).toBe(TENANT_A);
    }
  });
});

// ---------------------------------------------------------------------------
// CANARY — deliberate-bug-is-caught (automated)
// ---------------------------------------------------------------------------
describe('CANARY — the access-tag battery is sensitive to the filter', () => {
  it('a store with the access-tag filter dropped LEAKS the secret entity (proving the assertion has teeth)', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    // Against the real store this is null (asserted above). Against the
    // vulnerable store (tag filter dropped) the pub caller WRONGLY sees it.
    const real = await store.getEntity(readCtx(TENANT_A, PUB), a.entitySecret);
    const leaked = await vulnerable.getEntity(readCtx(TENANT_A, PUB), a.entitySecret);
    expect(real).toBeNull(); // the protection holds on the real store
    expect(leaked).not.toBeNull(); // and the canary proves the test would catch a regression
  });
  it('the vulnerable store also leaks via searchByVector', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const realRes = await store.searchByVector(readCtx(TENANT_A, PUB), {
      modelId: MODEL,
      k: 10,
      queryVector: fakeVector(2),
    });
    const leakedRes = await vulnerable.searchByVector(readCtx(TENANT_A, PUB), {
      modelId: MODEL,
      k: 10,
      queryVector: fakeVector(2),
    });
    expect(realRes.map((r) => r.targetId)).not.toContain(a.paraSecret);
    expect(leakedRes.map((r) => r.targetId)).toContain(a.paraSecret);
  });
  it('the vulnerable store also leaks via searchByKeyword', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const realRes = await store.searchByKeyword(readCtx(TENANT_A, PUB), {
      query: 'paragraph',
      k: 10,
    });
    const leakedRes = await vulnerable.searchByKeyword(readCtx(TENANT_A, PUB), {
      query: 'paragraph',
      k: 10,
    });
    expect(realRes.map((r) => r.targetId)).not.toContain(a.paraSecret);
    expect(leakedRes.map((r) => r.targetId)).toContain(a.paraSecret);
  });
  it('the vulnerable store also leaks a secret citation count', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const real = await store.countCitationsByParagraph(readCtx(TENANT_A, PUB), [a.paraSecret]);
    const leaked = await vulnerable.countCitationsByParagraph(readCtx(TENANT_A, PUB), [
      a.paraSecret,
    ]);
    expect(real.has(a.paraSecret)).toBe(false); // protection holds on the real store
    expect(leaked.get(a.paraSecret)).toBe(1); // canary proves the assertion has teeth
  });
  it('the vulnerable store also leaks the secret document via findDocuments', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const real = await store.findDocuments(readCtx(TENANT_A, PUB), {});
    const leaked = await vulnerable.findDocuments(readCtx(TENANT_A, PUB), {});
    expect(real.items.map((d) => d.id)).not.toContain(a.docSecret); // protection holds
    expect(leaked.items.map((d) => d.id)).toContain(a.docSecret); // canary would catch a regression
  });
  it('the vulnerable store also leaks via findEntities propertyEquals (M1.2 key-gather)', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const real = await store.findEntities(readCtx(TENANT_A, PUB), {
      propertyEquals: { property: 'name', value: 'secret' },
    });
    const leaked = await vulnerable.findEntities(readCtx(TENANT_A, PUB), {
      propertyEquals: { property: 'name', value: 'secret' },
    });
    expect(real.items.map((e) => e.id)).not.toContain(a.entitySecret); // protection holds
    expect(leaked.items.map((e) => e.id)).toContain(a.entitySecret); // canary catches a key-gather tag-bypass regression
  });
  it('the vulnerable store also leaks a secret stored vector via getEmbeddingsByTargets (P2-3)', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const real = await store.getEmbeddingsByTargets(readCtx(TENANT_A, PUB), {
      targetKind: 'paragraph',
      targetIds: [a.paraSecret as string],
      modelId: MODEL,
    });
    const leaked = await vulnerable.getEmbeddingsByTargets(readCtx(TENANT_A, PUB), {
      targetKind: 'paragraph',
      targetIds: [a.paraSecret as string],
      modelId: MODEL,
    });
    expect(real.map((e) => e.targetId)).not.toContain(a.paraSecret); // protection holds
    expect(leaked.map((e) => e.targetId)).toContain(a.paraSecret); // canary proves the vector read is filter-sensitive
  });
  it('the vulnerable store also leaks a secret review item via findPendingReviewItems (P6a)', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    const real = await store.findPendingReviewItems(readCtx(TENANT_A, PUB));
    const leaked = await vulnerable.findPendingReviewItems(readCtx(TENANT_A, PUB));
    expect(real.map((i) => i.id)).not.toContain(a.reviewSecret); // protection holds
    expect(leaked.map((i) => i.id)).toContain(a.reviewSecret); // canary proves the queue read is filter-sensitive
  });
  it('the vulnerable store still cannot cross tenants (bypass preserves tenant isolation)', async () => {
    const vulnerable = new VulnerableGraphStoreReader(store);
    expect(await vulnerable.getEntity(readCtx(TENANT_A, BOTH), b.entityPub)).toBeNull();
  });
});

async function bypassRowCount(): Promise<number> {
  const r = await db.select({ value: sql<number>`count(*)` }).from(internalBypassLog);
  return Number(r[0]?.value ?? 0);
}

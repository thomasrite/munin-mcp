// ===========================================================================
// GATHER PERMISSION — P0. DO NOT SKIP, DO NOT WEAKEN.
// ===========================================================================
//
// M1.2 gather-by-identity assembles "everything about X" by leading with the
// exact key (a structured key-gather), then cluster + depth-1 traversal. The
// trust-critical property: aggregation must NOT become a
// permission bypass.
//   1. A guest's gather returns ONLY their permitted records — an out-of-
//      clearance key-bearing record is never returned and never counted.
//   2. The uncertainty flag distinguishes no-key/unlinked (surfaced) from
//      permission-withheld (NEVER surfaced/counted). The estimate is computed
//      over the caller-visible space only.
//   3. THE no-leak invariant: a guest's gather result AND uncertainty flag are
//      byte-identical whether or not out-of-clearance records exist — so the
//      presence of withheld records cannot be inferred from the output.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type EntityId,
  type ExtractorVersionId,
  type ParagraphId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
} from '../graph/types';
import { gatherByIdentity } from '../query/gather';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000dd');
const ACTOR = asActorId('gather-perm');
const PUB = ['t:pub'];
const SECRET = ['t:secret'];
const KEY = 'EMP-100';

const readCtx = (tags: readonly string[]): ReadContext => ({
  kind: 'regular',
  tenantId: TENANT,
  accessTags: tags,
  actor: ACTOR,
});
const writeCtx = (): WriteContext => ({ tenantId: TENANT, actor: ACTOR });

let docPub: DocumentId;
let paraPub: ParagraphId;
let ext: ExtractorVersionId;
let pubClusterMember: EntityId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  client = postgres(container.getConnectionUri(), { max: 4 });
  await runMigrations(container.getConnectionUri());
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'gather-perm' });
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

// Seed: one logical person "Dana Reed" (employeeRef EMP-100) with TWO visible
// (PUB) key-bearing records and a helper to optionally add an out-of-clearance
// (SECRET) key-bearing record — the same person, same key, hidden from a guest.
async function seedBase(): Promise<void> {
  const ctx = writeCtx();
  docPub = (
    await store.insertDocument(ctx, {
      title: 'pub',
      blobStorageUri: 'b://p',
      sha256: 'shaP',
      accessTags: PUB,
    })
  ).id;
  paraPub = (
    await store.insertParagraphsBulk(ctx, [
      { documentId: docPub, paragraphIndex: 0, text: 'p', accessTags: PUB },
    ])
  )[0]!.id;
  ext = (
    await store.upsertExtractorVersion(ctx, {
      configurationId: 'c',
      configurationVersion: '0.1.0',
      schemaHash: 'h',
      promptHash: 'p',
      modelId: 'm',
    })
  ).id;
  const prov = {
    kind: 'document_extract' as const,
    documentId: docPub,
    paragraphId: paraPub,
    extractorVersionId: ext,
    confidence: 1,
  };
  pubClusterMember = (
    await store.insertEntity(ctx, {
      type: 'Employee',
      properties: { fullName: 'Dana Reed', employeeRef: KEY },
      accessTags: PUB,
      provenance: prov,
    })
  ).id;
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'D. Reed', employeeRef: KEY },
    accessTags: PUB,
    provenance: prov,
  });
}

async function addHiddenKeyBearingRecord(): Promise<void> {
  const ctx = writeCtx();
  const docSecret = (
    await store.insertDocument(ctx, {
      title: 'secret',
      blobStorageUri: 'b://s',
      sha256: 'shaS',
      accessTags: SECRET,
    })
  ).id;
  const paraSecret = (
    await store.insertParagraphsBulk(ctx, [
      { documentId: docSecret, paragraphIndex: 0, text: 's', accessTags: SECRET },
    ])
  )[0]!.id;
  const prov = {
    kind: 'document_extract' as const,
    documentId: docSecret,
    paragraphId: paraSecret,
    extractorVersionId: ext,
    confidence: 1,
  };
  // SAME person, SAME exact key — but tagged SECRET (out of a guest's clearance).
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'Dana Reed', employeeRef: KEY },
    accessTags: SECRET,
    provenance: prov,
  });
}

const target = () => ({
  entityType: 'Employee',
  keyProperty: 'employeeRef',
  keyValue: KEY,
  clusterMemberIds: [pubClusterMember],
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE entities, paragraphs, documents, extractor_versions RESTART IDENTITY CASCADE`,
  );
  await seedBase();
});

describe('gather-by-identity — permission scope (P0)', () => {
  it('a guest gather returns only the permitted records; a hidden key-bearing record is never gathered', async () => {
    await addHiddenKeyBearingRecord();
    const g = await gatherByIdentity(store, readCtx(PUB), target());
    // Only the PUB document is gathered; the SECRET same-key record is not.
    expect(g.documentIds).toContain(docPub);
    expect(g.documentIds).toHaveLength(1);
    expect(g.entityIds).toHaveLength(2); // the two PUB rows only
  });

  it('a full-access caller gathers all three records (control)', async () => {
    await addHiddenKeyBearingRecord();
    const g = await gatherByIdentity(store, readCtx([...PUB, ...SECRET]), target());
    expect(g.documentIds).toHaveLength(2); // pub + secret docs
    expect(g.entityIds).toHaveLength(3);
  });

  it('NO-LEAK: a guest gather result AND uncertainty flag are byte-identical with and without a hidden record', async () => {
    const withoutHidden = await gatherByIdentity(store, readCtx(PUB), target());
    await addHiddenKeyBearingRecord();
    const withHidden = await gatherByIdentity(store, readCtx(PUB), target());
    const norm = (g: Awaited<ReturnType<typeof gatherByIdentity>>) => ({
      entityIds: [...g.entityIds].sort(),
      documentIds: [...g.documentIds].sort(),
      viaKey: g.viaKey,
      viaClusterOrTraversal: g.viaClusterOrTraversal,
      mayHaveUnlinkedRecords: g.mayHaveUnlinkedRecords,
    });
    // The presence of an out-of-clearance record must not change ANY field —
    // including the uncertainty flag — or its existence could be inferred.
    expect(norm(withHidden)).toEqual(norm(withoutHidden));
  });

  it('uncertainty flag reflects ONLY no-key/unlinked records (a keyless visible record), never withheld', async () => {
    // Add a visible (PUB) record of the same person with NO key → unlinked.
    const ctx = writeCtx();
    const prov = {
      kind: 'document_extract' as const,
      documentId: docPub,
      paragraphId: paraPub,
      extractorVersionId: ext,
      confidence: 1,
    };
    const keyless = (
      await store.insertEntity(ctx, {
        type: 'Employee',
        properties: { fullName: 'Dana Reed' },
        accessTags: PUB,
        provenance: prov,
      })
    ).id;
    const g = await gatherByIdentity(store, readCtx(PUB), {
      ...target(),
      clusterMemberIds: [pubClusterMember, keyless],
    });
    expect(g.mayHaveUnlinkedRecords).toBe(true); // surfaced: a visible keyless record exists
  });
});

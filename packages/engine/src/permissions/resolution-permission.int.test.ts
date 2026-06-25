// ===========================================================================
// RESOLUTION PERMISSION — P0. DO NOT SKIP, DO NOT WEAKEN.
// ===========================================================================
//
// M1.1 entity resolution clusters at READ time. The trust-critical property:
// a guest "gathering everything about X" must only ever cluster records it can
// SEE — aggregation must not become a permission bypass, and an out-of-clearance
// row of the same person must neither appear in nor INFLUENCE the cluster (even
// using a hidden row to decide a cluster would leak identity/existence signal).
//
// The architecture guarantee: resolveEntities is PURE over the
// set it is GIVEN — it performs no reads. So permission-correctness reduces to:
// the pipeline feeds it only the caller-visible set (a normal access-tag read).
// This test proves both halves: (a) the visible-read excludes the hidden row,
// and (b) resolving the visible set yields a cluster of visible rows only, byte-
// identical whether or not a hidden same-person row exists in storage.

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
  type ParagraphId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
} from '../graph/types';
import { type ResolvableEntity, resolveEntities } from '../query/resolution';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000cc');
const ACTOR = asActorId('resolution-perm');
const PUB = ['t:pub'];
const SECRET = ['t:secret'];
const HINTS = new Map([['Employee', { identityProperties: ['fullName'] }]]);

const readCtx = (accessTags: readonly string[]): ReadContext => ({
  kind: 'regular',
  tenantId: TENANT,
  accessTags,
  actor: ACTOR,
});
const writeCtx = (): WriteContext => ({ tenantId: TENANT, actor: ACTOR });

let doc: DocumentId;
let para: ParagraphId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  client = postgres(container.getConnectionUri(), { max: 4 });
  await runMigrations(container.getConnectionUri());
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'resolution-perm' });
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // Content tables only — never tenants (cascades to the append-only bypass log).
  await db.execute(
    sql`TRUNCATE entities, paragraphs, documents, extractor_versions RESTART IDENTITY CASCADE`,
  );
  const ctx = writeCtx();
  doc = (
    await store.insertDocument(ctx, {
      title: 'd',
      blobStorageUri: 'b://d',
      sha256: 'sha',
      accessTags: PUB,
    })
  ).id;
  para = (
    await store.insertParagraphsBulk(ctx, [
      { documentId: doc, paragraphIndex: 0, text: 'p', accessTags: PUB },
    ])
  )[0]!.id;
  const ext = (
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
    documentId: doc,
    paragraphId: para,
    extractorVersionId: ext,
    confidence: 1,
  };
  // Same person "Sarah Jones": two visible (PUB) rows + one out-of-clearance (SECRET) row.
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'Sarah Jones' },
    accessTags: PUB,
    provenance: prov,
  });
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'Ms Jones' },
    accessTags: PUB,
    provenance: prov,
  });
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'S. Jones' },
    accessTags: SECRET,
    provenance: prov,
  });
});

// Resolve from a permission-filtered read, the way the pipeline does.
async function resolveUnder(tags: readonly string[]) {
  const entities = (await store.findEntities(readCtx(tags), { limit: 1000 })).items;
  const resolvable: ResolvableEntity[] = entities.map((e) => ({
    id: e.id,
    type: e.type,
    properties: e.properties,
    // No context vector needed: these are name-form variants of one person; with
    // identityProperties the resolver clusters compatible names. (We pass a shared
    // vector so confirm-to-merge fires — the point here is permission scope, not
    // the merge heuristic.)
    contextVector: [1, 0, 0],
  }));
  return { entities, result: resolveEntities(resolvable, HINTS) };
}

describe('resolution — permission scope (P0)', () => {
  it('a guest resolves only over visible rows; the out-of-clearance row is absent from input AND output', async () => {
    const { entities, result } = await resolveUnder(PUB);
    const ids = new Set(entities.map((e) => e.id));
    expect(entities).toHaveLength(2); // the SECRET row is not even read
    const names = entities.map((e) => e.properties.fullName);
    expect(names).not.toContain('S. Jones');
    // The cluster contains only the two visible rows.
    const merged = result.clusters.flatMap((c) => c.memberIds);
    expect(new Set(merged)).toEqual(ids);
  });

  it('the hidden row does not INFLUENCE the visible cluster (identical with and without it)', async () => {
    const withHidden = await resolveUnder(PUB);
    // Remove the SECRET row entirely and re-resolve; the guest result must be identical.
    await db.execute(sql`DELETE FROM entities WHERE 't:secret' = ANY(access_tags)`);
    const withoutHidden = await resolveUnder(PUB);
    const norm = (r: Awaited<ReturnType<typeof resolveUnder>>) =>
      r.result.clusters.map((c) => [...c.memberIds].sort()).sort();
    expect(norm(withHidden)).toEqual(norm(withoutHidden));
  });

  it('a full-access caller sees all three rows (control)', async () => {
    const { entities } = await resolveUnder([...PUB, ...SECRET]);
    expect(entities).toHaveLength(3);
  });
});

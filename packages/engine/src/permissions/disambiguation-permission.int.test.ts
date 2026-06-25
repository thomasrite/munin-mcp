// ===========================================================================
// DISAMBIGUATION PERMISSION — P0. DO NOT SKIP, DO NOT WEAKEN.
// ===========================================================================
//
// M1.3 packages same-name candidate clusters for the caller to pick between
// (present → pick → re-gather). The trust-critical property: a
// disambiguation must NEVER reveal a same-name person the caller cannot see.
// Telling a guest "did you mean Sarah Jones (Northgate) or Sarah Jones
// (Westfield)?" when they may only see Northgate would leak the existence of a
// confidential second person.
//
// The architecture guarantee: `buildDisambiguation` is PURE over the entity set
// it is GIVEN — it performs NO reads, NO internalBypass. The pipeline feeds it
// only the caller-visible set (a normal access-tag read). So an out-of-clearance
// same-name person produces no cluster in the caller's view → is never offered
// as a candidate. This test proves it end-to-end AND pins the no-leak invariant:
// the guest's disambiguation result is BYTE-IDENTICAL whether or not the hidden
// same-name person exists in storage.
//
// MUTATION THIS CATCHES (PERMISSION-MUTATION-TESTS.md): if the disambiguation
// path were "completed" with an internalBypass read to find all same-name people
// regardless of clearance, the hidden person would appear as a candidate and the
// byte-identical assertion would fail.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EntityResolutionHints } from '@muninhq/shared';
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
import { buildDisambiguation } from '../query/disambiguation';
import { type ResolvableEntity, resolveEntities } from '../query/resolution';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000de');
const ACTOR = asActorId('disambig-perm');
const PUB = ['t:pub'];
const SECRET = ['t:secret'];
// Distinguishing `department` so the two same-name people are CONFIDENTLY distinct
// (a real disambiguation between two people, not an uncertain split).
const HINTS = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'], distinguishingProperties: ['department'] }],
]);

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
  await db.insert(tenants).values({ id: TENANT, name: 'disambig-perm' });
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
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
  // Two DIFFERENT people who share the name "Sarah Jones":
  //   A — visible (PUB), department Northgate
  //   B — out-of-clearance (SECRET), department Westfield
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'Sarah Jones', department: 'Northgate' },
    accessTags: PUB,
    provenance: prov,
  });
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'Sarah Jones', department: 'Westfield' },
    accessTags: SECRET,
    provenance: prov,
  });
});

async function disambiguateUnder(tags: readonly string[]) {
  const entities = (await store.findEntities(readCtx(tags), { limit: 1000 })).items;
  const resolvable: ResolvableEntity[] = entities.map((e) => ({
    id: e.id,
    type: e.type,
    properties: e.properties,
    contextVector: null,
  }));
  const resolution = resolveEntities(resolvable, HINTS);
  return { entities, result: buildDisambiguation(resolution, resolvable, HINTS) };
}

describe('disambiguation — permission scope (P0)', () => {
  it('a full-access caller is offered BOTH same-name people as candidates', async () => {
    const { entities, result } = await disambiguateUnder([...PUB, ...SECRET]);
    expect(entities).toHaveLength(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.candidates).toHaveLength(2);
    const departments = result.groups[0]!.candidates.flatMap(
      (c) => c.distinguishing.department ?? [],
    );
    expect(departments).toEqual(expect.arrayContaining(['Northgate', 'Westfield']));
  });

  it('a guest is NEVER offered the out-of-clearance same-name person', async () => {
    const { entities, result } = await disambiguateUnder(PUB);
    expect(entities).toHaveLength(1); // the SECRET row is not even read
    // Only one visible person → no disambiguation question, and Westfield is
    // never surfaced anywhere in the result.
    expect(result.groups).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('Westfield');
  });

  it('NO-LEAK: the guest result is byte-identical whether or not the hidden person exists', async () => {
    const withHidden = await disambiguateUnder(PUB);
    await db.execute(sql`DELETE FROM entities WHERE 't:secret' = ANY(access_tags)`);
    const withoutHidden = await disambiguateUnder(PUB);
    expect(JSON.stringify(withHidden.result)).toEqual(JSON.stringify(withoutHidden.result));
  });
});

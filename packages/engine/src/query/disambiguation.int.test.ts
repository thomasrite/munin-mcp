// Disambiguation round-trip (M1.3) — present → pick → re-gather, end-to-end
// against Postgres + the real M1.2 gather. Deterministic, no answer model. This
// is the authoritative exerciser for the engine-side contract: a colliding-name
// query presents >= 2 candidates; a pick re-gathers EXACTLY that person's
// records (and not the other's), proving the pick is a gather-target selection,
// never a merge.

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
  type ExtractorVersionId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
} from '../graph/types';
import { buildDisambiguation, gatherTargetForCandidate, selectCandidate } from './disambiguation';
import { gatherByIdentity } from './gather';
import { type ResolvableEntity, resolveEntities } from './resolution';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000df');
const ACTOR = asActorId('disambig-roundtrip');
const TAGS = ['t:all'];
const HINTS = new Map<string, EntityResolutionHints>([
  [
    'Employee',
    {
      identityProperties: ['fullName'],
      distinguishingProperties: ['department'],
      exactKeyProperties: ['employeeRef'],
    },
  ],
]);

const readCtx = (): ReadContext => ({
  kind: 'regular',
  tenantId: TENANT,
  accessTags: TAGS,
  actor: ACTOR,
});
const writeCtx = (): WriteContext => ({ tenantId: TENANT, actor: ACTOR });

let ext: ExtractorVersionId;

// Insert a record doc + an Employee entity for `person`, returning the doc id.
async function insertRecord(
  fullName: string,
  department: string,
  ref: string,
): Promise<DocumentId> {
  const ctx = writeCtx();
  const doc = (
    await store.insertDocument(ctx, {
      title: `${fullName}-${department}`,
      blobStorageUri: `b://${ref}-${Math.random()}`,
      sha256: `sha-${Math.random()}`,
      accessTags: TAGS,
    })
  ).id;
  const para = (
    await store.insertParagraphsBulk(ctx, [
      {
        documentId: doc,
        paragraphIndex: 0,
        text: `${fullName} at ${department}`,
        accessTags: TAGS,
      },
    ])
  )[0]!.id;
  const prov = {
    kind: 'document_extract' as const,
    documentId: doc,
    paragraphId: para,
    extractorVersionId: ext,
    confidence: 1,
  };
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName, department, employeeRef: ref },
    accessTags: TAGS,
    provenance: prov,
  });
  return doc;
}

let aDocs: DocumentId[];
let bDocs: DocumentId[];

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  client = postgres(container.getConnectionUri(), { max: 4 });
  await runMigrations(container.getConnectionUri());
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'disambig-roundtrip' });
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE entities, paragraphs, documents, extractor_versions RESTART IDENTITY CASCADE`,
  );
  ext = (
    await store.upsertExtractorVersion(writeCtx(), {
      configurationId: 'c',
      configurationVersion: '0.1.0',
      schemaHash: 'h',
      promptHash: 'p',
      modelId: 'm',
    })
  ).id;
  // Two different "Sarah Jones": A at Northgate (EMP-1, 3 records), B at
  // Westfield (EMP-2, 2 records). Distinct keys → confidently distinct.
  aDocs = [
    await insertRecord('Sarah Jones', 'Northgate', 'EMP-1'),
    await insertRecord('Ms Jones', 'Northgate', 'EMP-1'),
    await insertRecord('Sarah Jones', 'Northgate', 'EMP-1'),
  ];
  bDocs = [
    await insertRecord('Sarah Jones', 'Westfield', 'EMP-2'),
    await insertRecord('S. Jones', 'Westfield', 'EMP-2'),
  ];
});

async function presentAndPickByKey(wantRef: string) {
  const entities = (await store.findEntities(readCtx(), { limit: 1000 })).items;
  const resolvable: ResolvableEntity[] = entities.map((e) => ({
    id: e.id,
    type: e.type,
    properties: e.properties,
    contextVector: null,
  }));
  const byId = new Map(resolvable.map((e) => [e.id, e]));
  const resolution = resolveEntities(resolvable, HINTS);
  const dis = buildDisambiguation(resolution, resolvable, HINTS);
  // Pick the candidate whose members carry the wanted key.
  const group = dis.groups[0]!;
  const wanted = group.candidates.find((c) =>
    c.memberIds.some((id) => byId.get(id)?.properties.employeeRef === wantRef),
  )!;
  const chosen = selectCandidate(dis, wanted.token)!;
  const target = gatherTargetForCandidate(chosen, byId, HINTS);
  const records = await gatherByIdentity(store, readCtx(), target);
  return { dis, target, records };
}

describe('disambiguation round-trip (present → pick → re-gather)', () => {
  it('presents two candidates for the colliding name', async () => {
    const { dis } = await presentAndPickByKey('EMP-1');
    expect(dis.groups).toHaveLength(1);
    expect(dis.groups[0]!.candidates).toHaveLength(2);
  });

  it('re-gathering the picked candidate returns ONLY that person’s records', async () => {
    const { target, records } = await presentAndPickByKey('EMP-1');
    expect(target.keyProperty).toBe('employeeRef');
    expect(target.keyValue).toBe('EMP-1');
    const got = new Set(records.documentIds as readonly string[]);
    // A's three docs are present; none of B's are.
    for (const d of aDocs) expect(got.has(d)).toBe(true);
    for (const d of bDocs) expect(got.has(d)).toBe(false);
  });

  it('picking the OTHER candidate returns the other person (the pick selects identity, not a merge)', async () => {
    const { target, records } = await presentAndPickByKey('EMP-2');
    expect(target.keyValue).toBe('EMP-2');
    const got = new Set(records.documentIds as readonly string[]);
    for (const d of bDocs) expect(got.has(d)).toBe(true);
    for (const d of aDocs) expect(got.has(d)).toBe(false);
  });

  it('a stale/unknown token yields no candidate (re-present)', async () => {
    const entities = (await store.findEntities(readCtx(), { limit: 1000 })).items;
    const resolvable: ResolvableEntity[] = entities.map((e) => ({
      id: e.id,
      type: e.type,
      properties: e.properties,
      contextVector: null,
    }));
    const dis = buildDisambiguation(resolveEntities(resolvable, HINTS), resolvable, HINTS);
    expect(selectCandidate(dis, 'ffffffffffffffff')).toBeNull();
  });
});

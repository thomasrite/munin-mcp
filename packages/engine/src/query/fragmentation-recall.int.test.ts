// F9 fragmentation resolution — recall + the never-false-merge catastrophe guard,
// end-to-end against Postgres + the real M1.2 gather. Deterministic, no answer
// model: resolveEntities clusters the name-form variants, then gatherByIdentity
// expands across that cluster.
//
// Recall scenario: one person fragmented across keyed + KEYLESS variant names
// (the production reality — no context vectors). Pre-F9 the keyless fragments
// split out, so gathering the keyed cluster misses their records; F9 clusters the
// variants so gather reaches them all.
//
// Catastrophe scenario: two genuinely-different same-surname people with DIFFERENT
// exact keys. They must NEVER be merged, and an ambiguous keyless "Ms Voss" must
// attach to NEITHER — gathering one returns only that person's records.

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
  type EntityId,
  type ExtractorVersionId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
} from '../graph/types';
import { gatherTargetForCluster } from './disambiguation';
import { gatherByIdentity } from './gather';
import { type ResolvableEntity, resolveEntities } from './resolution';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000f9');
const ACTOR = asActorId('frag-recall');
const TAGS = ['t:all'];
const HINTS = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['employeeRef'] }],
]);

const readCtx = (): ReadContext => ({
  kind: 'regular',
  tenantId: TENANT,
  accessTags: TAGS,
  actor: ACTOR,
});
const writeCtx = (): WriteContext => ({ tenantId: TENANT, actor: ACTOR });

let ext: ExtractorVersionId;

// Insert one source document + an Employee entity mentioning `fullName`. `ref`
// undefined ⇒ a keyless mention (e.g. a grievance letter naming "Ms Voss" with no
// employee reference). Returns the doc + entity ids.
async function insertRecord(
  fullName: string,
  ref: string | undefined,
): Promise<{ doc: DocumentId; entity: EntityId }> {
  const ctx = writeCtx();
  const doc = (
    await store.insertDocument(ctx, {
      title: `${fullName}-${Math.random()}`,
      blobStorageUri: `b://${Math.random()}`,
      sha256: `sha-${Math.random()}`,
      accessTags: TAGS,
    })
  ).id;
  const para = (
    await store.insertParagraphsBulk(ctx, [
      { documentId: doc, paragraphIndex: 0, text: `record about ${fullName}`, accessTags: TAGS },
    ])
  )[0]!.id;
  const entity = await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName, ...(ref ? { employeeRef: ref } : {}) },
    accessTags: TAGS,
    provenance: {
      kind: 'document_extract' as const,
      documentId: doc,
      paragraphId: para,
      extractorVersionId: ext,
      confidence: 1,
    },
  });
  return { doc, entity: entity.id };
}

async function resolvableSet(): Promise<{
  resolvable: ResolvableEntity[];
  byId: Map<string, ResolvableEntity>;
}> {
  const entities = (await store.findEntities(readCtx(), { limit: 1000 })).items;
  // Production reality: no context vectors are supplied (F9 must work without them).
  const resolvable: ResolvableEntity[] = entities.map((e) => ({
    id: e.id,
    type: e.type,
    properties: e.properties,
    contextVector: null,
  }));
  return { resolvable, byId: new Map(resolvable.map((e) => [e.id, e])) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  client = postgres(container.getConnectionUri(), { max: 4 });
  await runMigrations(container.getConnectionUri());
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'frag-recall' });
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
});

describe('F9 fragmentation recall (gather reaches the variant fragments)', () => {
  it('clusters keyed + keyless variants → gather recall jumps from keyed-only to 100%', async () => {
    // One real person "Helena Voss", fragmented across 12 records: 4 carry the
    // employeeRef (keyed), 8 are KEYLESS reduced-form mentions. No same-name decoy.
    const keyed = [
      await insertRecord('Helena Voss', 'EMP-001'),
      await insertRecord('Helena Voss', 'EMP-001'),
      await insertRecord('H. Voss', 'EMP-001'),
      await insertRecord('Helena Voss', 'EMP-001'),
    ];
    const keyless = [
      await insertRecord('Ms Voss', undefined),
      await insertRecord('H. Voss', undefined),
      await insertRecord('Ms Voss', undefined),
      await insertRecord('H Voss', undefined),
      await insertRecord('Ms. Voss', undefined),
      await insertRecord('H. Voss', undefined),
      await insertRecord('Ms Voss', undefined),
      await insertRecord('H. Voss', undefined),
    ];
    const allDocs = new Set<string>([...keyed, ...keyless].map((r) => r.doc));
    expect(allDocs.size).toBe(12);

    const { resolvable, byId } = await resolvableSet();
    const resolution = resolveEntities(resolvable, HINTS);

    // F9: one logical cluster for Helena Voss spanning all 12 variant rows.
    const cluster = resolution.clusters.find((c) => c.memberIds.includes(keyed[0]!.entity))!;
    expect(cluster.memberIds).toHaveLength(12);

    // BEFORE (pre-F9 ≈ exact-key-only): the cluster would be just the keyed rows.
    const beforeTarget = gatherTargetForCluster(
      'Employee',
      keyed.map((r) => r.entity),
      byId,
      HINTS,
    );
    const before = await gatherByIdentity(store, readCtx(), beforeTarget);
    const beforeDocs = new Set(before.documentIds as readonly string[]);

    // AFTER (F9): gather across the full variant cluster.
    const afterTarget = gatherTargetForCluster('Employee', cluster.memberIds, byId, HINTS);
    const after = await gatherByIdentity(store, readCtx(), afterTarget);
    const afterDocs = new Set(after.documentIds as readonly string[]);

    const recall = (got: Set<string>) =>
      [...allDocs].filter((d) => got.has(d)).length / allDocs.size;

    // Measurement output (noConsole is off for test files) — the recall lift.
    console.log(
      `\n=== F9 fragmentation recall ===\n  before (keyed-only): ${(recall(beforeDocs) * 100).toFixed(0)}% (${beforeDocs.size}/12)\n  after  (F9 cluster): ${(recall(afterDocs) * 100).toFixed(0)}% (${afterDocs.size}/12)\n`,
    );

    expect(recall(beforeDocs)).toBeLessThan(0.5); // keyed-only misses the keyless fragments
    expect(recall(afterDocs)).toBe(1); // F9 reaches every record
  });
});

describe('F9 catastrophe guard at the gather level (never cross-attribute)', () => {
  it('two same-name different-key people are never merged; an ambiguous variant attaches to neither', async () => {
    // Two genuinely-different "Helena Voss" + a keyless "Ms Voss" that could be
    // either.
    const p = [
      await insertRecord('Helena Voss', 'EMP-001'),
      await insertRecord('H. Voss', 'EMP-001'),
      await insertRecord('Helena Voss', 'EMP-001'),
    ];
    const q = [
      await insertRecord('Helena Voss', 'EMP-002'),
      await insertRecord('Helena Voss', 'EMP-002'),
    ];
    const ambiguous = await insertRecord('Ms Voss', undefined);

    const { resolvable, byId } = await resolvableSet();
    const resolution = resolveEntities(resolvable, HINTS);

    const pCluster = resolution.clusters.find((c) => c.memberIds.includes(p[0]!.entity))!;
    const qCluster = resolution.clusters.find((c) => c.memberIds.includes(q[0]!.entity))!;

    // NEVER MERGED: the two key-distinct identities share no member, and the
    // ambiguous keyless mention is attached to neither.
    expect(pCluster.memberIds).not.toContain(q[0]!.entity);
    expect(pCluster.memberIds).not.toContain(ambiguous.entity);
    expect(qCluster.memberIds).not.toContain(ambiguous.entity);
    expect(pCluster.memberIds).not.toContain(q[1]!.entity);

    // Gathering P returns ONLY P's records — never Q's, never the ambiguous one.
    const pTarget = gatherTargetForCluster('Employee', pCluster.memberIds, byId, HINTS);
    const pGather = await gatherByIdentity(store, readCtx(), pTarget);
    const pDocs = new Set(pGather.documentIds as readonly string[]);
    for (const r of p) expect(pDocs.has(r.doc)).toBe(true);
    for (const r of q) expect(pDocs.has(r.doc)).toBe(false);
    expect(pDocs.has(ambiguous.doc)).toBe(false);
  });
});

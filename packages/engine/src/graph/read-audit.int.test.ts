// Per-read audit (F10/F26) against REAL Postgres.
//
// Three properties on the real database:
//   1. A regular read through the audited store lands ONE content-free
//      audit_events row — correct actor / access tags / resultCount, and the
//      serialised row contains NO document/entity content and NO query text.
//   2. NO-LEAK SMOKE through the DECORATED store: a reader sees exactly what
//      the raw store would show them — the decorator widens nothing, for a
//      cleared reader, an uncleared reader, and an empty-tags reader. (The P0
//      permission suite continues to cover the raw store; this proves the
//      decorator preserves it.)
//   3. A forced writer failure (writer pointed at a dropped table) NEVER fails
//      the read — fail-open with the visible drop counter.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { auditEvents, tenants } from '../db/schema';
import { AuditedGraphStore } from './audited-graph-store';
import { PostgresGraphStore } from './postgres-graph-store';
import { BatchedReadAuditWriter } from './read-audit';
import {
  type DocumentId,
  type EntityId,
  type ParagraphId,
  type RegularReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
} from './types';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
let writer: BatchedReadAuditWriter;
let audited: AuditedGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const READER = asActorId('reader-oid');
const SECRET_TEXT = 'confidential-marker-outcome-x9';
const SECRET_TAG = 't:secret';
const OPEN_TAG = 't:open';

const regular = (tags: readonly string[], tenantId: TenantId = TENANT): RegularReadContext => ({
  kind: 'regular',
  tenantId,
  accessTags: tags,
  actor: READER,
});

let openEntity: EntityId;
let secretEntity: EntityId;
let docId: DocumentId;
let paraId: ParagraphId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  writer = new BatchedReadAuditWriter(db, { flushAtCount: 1_000, flushIntervalMs: 60_000 });
  audited = new AuditedGraphStore(store, writer);
  await db.insert(tenants).values([{ id: TENANT, name: 'A' }]);

  const wctx: WriteContext = { tenantId: TENANT, actor: READER };
  openEntity = (
    await store.insertEntity(wctx, {
      type: 'Thing',
      properties: { name: 'open-thing' },
      accessTags: [OPEN_TAG],
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;
  secretEntity = (
    await store.insertEntity(wctx, {
      type: 'Thing',
      properties: { name: SECRET_TEXT },
      accessTags: [SECRET_TAG],
      provenance: { kind: 'manual', confidence: null },
    })
  ).id;
  const doc = await store.insertDocument(wctx, {
    title: SECRET_TEXT,
    blobStorageUri: 'mem://doc',
    sha256: 'a'.repeat(64),
    mimeType: 'text/plain',
    accessTags: [SECRET_TAG],
  });
  docId = doc.id;
  const paras = await store.insertParagraphsBulk(wctx, [
    {
      documentId: docId,
      paragraphIndex: 0,
      page: 1,
      text: SECRET_TEXT,
      accessTags: [SECRET_TAG],
    },
  ]);
  paraId = (paras[0] as { id: ParagraphId }).id;
}, 180_000);

afterAll(async () => {
  if (writer) await writer.close();
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

afterEach(async () => {
  // Drain the shared writer FIRST so events buffered by one test can never
  // surface as rows in a later test's assertions.
  await writer.flush();
  await db.execute(sql`TRUNCATE audit_events RESTART IDENTITY CASCADE`);
});

async function readAuditRows() {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT));
  return rows.filter((r) => r.action.startsWith('read.'));
}

describe('per-read audit rows on real Postgres', () => {
  it('a regular read writes one content-free row with correct actor/tags/count', async () => {
    const ctx = regular([SECRET_TAG, OPEN_TAG]);
    const found = await audited.getEntity(ctx, secretEntity);
    expect(found?.id).toBe(secretEntity); // the read itself is unchanged
    await writer.flush();

    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      action: 'read.getEntity',
      targetKind: 'entity',
      targetId: secretEntity,
      actor: READER,
      details: { resultCount: 1 },
    });
    expect([...(row?.accessTagsUsed ?? [])].sort()).toEqual([OPEN_TAG, SECRET_TAG]);
    // ZERO CONTENT: the serialised row never carries entity/document values.
    expect(JSON.stringify(row)).not.toContain(SECRET_TEXT);
  });

  it('search reads audit the hit count, never the query text', async () => {
    const ctx = regular([SECRET_TAG]);
    const hits = await audited.searchByKeyword(ctx, {
      query: 'confidential unique-query-marker-x9',
      k: 5,
    });
    await writer.flush();

    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('read.searchByKeyword');
    expect(rows[0]?.details).toEqual({ resultCount: hits.length });
    expect(JSON.stringify(rows[0])).not.toContain('unique-query-marker-x9');
  });

  it('reads inside withTransaction are audited too (the per-tx store cannot escape)', async () => {
    const wctx: WriteContext = { tenantId: TENANT, actor: READER };
    await audited.withTransaction(wctx, async (tx) => {
      await tx.getDocument(regular([SECRET_TAG]), docId);
      return null;
    });
    await writer.flush();

    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('read.getDocument');
    expect(rows[0]?.targetId).toBe(docId);
  });
});

describe('decorated no-leak smoke — the decorator widens nothing', () => {
  it('cleared / uncleared / empty-tags readers see exactly what the raw store shows', async () => {
    const cleared = regular([SECRET_TAG]);
    const uncleared = regular([OPEN_TAG]);
    const empty = regular([]);

    for (const ctx of [cleared, uncleared, empty]) {
      const [rawEntity, auditedEntity] = await Promise.all([
        store.getEntity(ctx, secretEntity),
        audited.getEntity(ctx, secretEntity),
      ]);
      expect(auditedEntity?.id).toBe(rawEntity?.id);
      expect(auditedEntity === null).toBe(rawEntity === null);

      const [rawParas, auditedParas] = await Promise.all([
        store.getParagraphsByIds(ctx, [paraId]),
        audited.getParagraphsByIds(ctx, [paraId]),
      ]);
      expect(auditedParas.map((p) => p.id)).toEqual(rawParas.map((p) => p.id));
    }

    // The fail-closed shape, explicitly: uncleared and empty-tags see nothing.
    expect(await audited.getEntity(uncleared, secretEntity)).toBeNull();
    expect(await audited.getEntity(empty, openEntity)).toBeNull();
    // And the cleared reader's view is intact.
    expect((await audited.getEntity(cleared, secretEntity))?.id).toBe(secretEntity);
  });
});

describe('forced writer failure — fail-open with a visible counter', () => {
  it('a read through a store whose audit writer cannot write still succeeds', async () => {
    // A writer whose every insert rejects — the "audit store unavailable" case.
    const failingWriter = new BatchedReadAuditWriter(
      {
        insert: () => ({
          values: () => Promise.reject(new Error('audit store unavailable')),
        }),
      } as never,
      { flushAtCount: 1_000, flushIntervalMs: 60_000 },
    );
    const failingAudited = new AuditedGraphStore(store, failingWriter);

    const ctx = regular([SECRET_TAG]);
    const found = await failingAudited.getEntity(ctx, secretEntity);
    expect(found?.id).toBe(secretEntity); // the read NEVER fails
    await failingWriter.flush();
    expect(failingWriter.dropped).toBe(1); // honest, visible loss
    await failingWriter.close();

    const rows = await readAuditRows();
    expect(rows).toHaveLength(0);
  });
});

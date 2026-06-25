// Integration tests for the eraseDocument orchestrator (P6b) against REAL
// Postgres + a real (in-memory) BlobStorage.
//
// Proves INVARIANT 2 (honest erasure) end-to-end: the DB transaction commits
// first (rows gone), then the blob is deleted and VERIFIED gone, and the
// content-free receipt reports the TRUTH. The honest-FAILURE path is the
// critical case: when the blob delete/verify fails, the DB rows are still erased
// but the receipt says NOT fully erased (flagged for retry) and an
// incomplete-erasure audit row is written — we never claim erased while content
// remains.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { BlobStorage } from '../blob/blob-storage';
import { runMigrations } from '../db/migrate';
import { auditEvents, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type ReadContext,
  type TenantId,
  asActorId,
  asTenantId,
  internalBypass,
} from '../graph/types';

import { eraseDocument } from './erase-document';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000e0');
const ACTOR = asActorId('dpo-oid');
const TAGS = ['t:hr'];

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const writeCtx = { tenantId: TENANT, actor: ACTOR };
const bypassCtx: ReadContext = {
  kind: 'bypass',
  tenantId: TENANT,
  bypass: internalBypass('erase-document.test', 'test confirms the document is gone'),
  actor: ACTOR,
};

// A faithful in-memory BlobStorage with INJECTABLE failure for the honest-
// failure path: `failDelete` makes delete throw; `ignoreDelete` makes delete a
// silent no-op so exists() still reports the blob present (delete "succeeded"
// but did not remove it).
class TestBlob implements BlobStorage {
  private readonly blobs = new Map<string, Uint8Array>();
  failDelete = false;
  ignoreDelete = false;
  async put(tenantId: TenantId, relativePath: string, bytes: Uint8Array): Promise<string> {
    const uri = `mem://${tenantId}/${relativePath}`;
    this.blobs.set(uri, bytes);
    return uri;
  }
  async get(uri: string): Promise<Uint8Array> {
    const b = this.blobs.get(uri);
    if (!b) throw new Error(`not found: ${uri}`);
    return b;
  }
  async exists(uri: string): Promise<boolean> {
    return this.blobs.has(uri);
  }
  async delete(uri: string): Promise<void> {
    if (this.failDelete) throw new Error('simulated blob backend outage');
    if (this.ignoreDelete) return; // pretends success but leaves the bytes
    this.blobs.delete(uri);
  }
  async ensureTenantContainer(): Promise<void> {}
}

let blob: TestBlob;

// Seed a document with a real blob + a paragraph + an entity-embedding, so we
// can confirm end-to-end that both the rows and the blob go.
async function seed(): Promise<{ doc: DocumentId; blobUri: string }> {
  const blobUri = await blob.put(TENANT, 'erase-me.txt', new TextEncoder().encode('pii bytes'));
  const doc = (
    await store.insertDocument(writeCtx, {
      title: 'erase me',
      blobStorageUri: blobUri,
      accessTags: TAGS,
    })
  ).id;
  await store.insertParagraphsBulk(writeCtx, [
    { documentId: doc, paragraphIndex: 0, text: 'p0', accessTags: TAGS },
  ]);
  return { doc, blobUri };
}

async function auditActions(): Promise<string[]> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'erase' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

afterEach(async () => {
  // internal_bypass_log is append-only (not truncatable); everything else resets.
  await db.execute(sql`TRUNCATE documents, paragraphs, entities, edges, embeddings,
    extractor_versions, citation_events, document_duplicates, audit_events
    RESTART IDENTITY CASCADE`);
  vi.restoreAllMocks();
});

describe('eraseDocument — INVARIANT 2: honest erasure (DB first, then verified blob)', () => {
  it('erases the rows AND the blob, and reports fullyErased with a verified-gone blob', async () => {
    blob = new TestBlob();
    const { doc, blobUri } = await seed();

    const receipt = await eraseDocument({ store, blobStorage: blob }, writeCtx, doc);

    // DB rows gone (document unreachable).
    expect(await store.getDocument(bypassCtx, doc)).toBeNull();
    // Blob verified gone.
    expect(await blob.exists(blobUri)).toBe(false);
    // The receipt tells the truth.
    expect(receipt.blobDeleted).toBe(true);
    expect(receipt.fullyErased).toBe(true);
    expect(receipt.blobError).toBeUndefined();
    expect(receipt.blobUri).toBe(blobUri);
    // Only the in-tx erasure audit row — no incomplete-erasure follow-up.
    expect(await auditActions()).toEqual(['hard_delete_document']);
  });

  it('HONEST FAILURE: blob delete throws → rows still erased, receipt NOT fully erased, flagged + audited', async () => {
    blob = new TestBlob();
    const { doc, blobUri } = await seed();
    blob.failDelete = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const receipt = await eraseDocument({ store, blobStorage: blob }, writeCtx, doc);

    // The DB transaction committed FIRST — the rows are gone regardless of the blob.
    expect(await store.getDocument(bypassCtx, doc)).toBeNull();
    // …but the blob remains, and the receipt is HONEST about it.
    expect(await blob.exists(blobUri)).toBe(true);
    expect(receipt.blobDeleted).toBe(false);
    expect(receipt.fullyErased).toBe(false);
    expect(receipt.blobError).toContain('simulated blob backend outage');
    // Warned + a persistent incomplete-erasure audit row (flagged for retry).
    expect(warn).toHaveBeenCalled();
    expect(await auditActions()).toEqual([
      'hard_delete_document',
      'hard_delete_document_incomplete',
    ]);
  });

  it('HONEST FAILURE: delete "succeeds" but the blob is still present → not fully erased', async () => {
    blob = new TestBlob();
    const { doc, blobUri } = await seed();
    blob.ignoreDelete = true; // delete() returns OK but does not remove the bytes
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const receipt = await eraseDocument({ store, blobStorage: blob }, writeCtx, doc);

    expect(await store.getDocument(bypassCtx, doc)).toBeNull();
    expect(await blob.exists(blobUri)).toBe(true);
    expect(receipt.blobDeleted).toBe(false);
    expect(receipt.fullyErased).toBe(false);
    expect(receipt.blobError).toBe('blob still present after delete');
    expect(await auditActions()).toContain('hard_delete_document_incomplete');
  });

  it('is idempotent at the blob layer — a retry after the blob is already gone still reports fully erased', async () => {
    blob = new TestBlob();
    // The document references a blob URI that was already removed (a prior partial
    // erasure). delete() of a missing blob is a no-op success; exists() is false.
    const { doc } = await seed();
    await blob.delete((await store.getDocument(bypassCtx, doc))!.blobStorageUri);

    const receipt = await eraseDocument({ store, blobStorage: blob }, writeCtx, doc);
    expect(receipt.blobDeleted).toBe(true);
    expect(receipt.fullyErased).toBe(true);
  });
});

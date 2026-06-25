// STOP GATE (P1): prove the EXISTING engine migrations and the reused
// PostgresGraphStore run UNCHANGED on PGlite (real Postgres compiled to WASM).
//
// This runs IN-PROCESS — no Docker, no testcontainer — so it lives in the unit
// suite. `beforeAll` runs every migration (0000–0010) on a fresh in-memory
// PGlite: if any Postgres-specific DDL fails (the pgvector HNSW index, the GIN
// index on the TEXT[] access_tags, the PL/pgSQL triggers, the english tsvector
// config, the vector(1024) column), the boot throws and the whole file fails
// loudly — that is the STOP-and-report signal. The individual tests then drive
// each risky feature through the real store API to prove it works at runtime,
// not merely that the DDL applied.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { internalBypassLog, tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from './pglite-graph-store';
import {
  type Document,
  type Entity,
  type Paragraph,
  type ReadContext,
  type WriteContext,
  asActorId,
  asParagraphId,
  asTenantId,
  internalBypass,
} from './types';

const TENANT = asTenantId(crypto.randomUUID());
const ACTOR = asActorId('stop-gate-test');
const MODEL = 'stop-gate-model';

// A 1024-dim vector (the schema's fixed EMBEDDING_DIMENSIONS).
function vec(fill: number): number[] {
  return Array.from({ length: 1024 }, () => fill);
}

function regular(tags: readonly string[]): ReadContext {
  return { kind: 'regular', tenantId: TENANT, accessTags: tags, actor: ACTOR };
}

let handle: PgliteGraphStoreHandle;
let doc: Document;
let para: Paragraph;
let entity: Entity;

beforeAll(async () => {
  // ---- THE STOP GATE ----
  handle = await createPgliteGraphStore({}); // in-memory PGlite
  await handle.db.insert(tenants).values({ id: TENANT, name: 'Local Tenant' });

  const wctx: WriteContext = { tenantId: TENANT, actor: ACTOR };
  // Generic (vertical-agnostic) fixtures — the engine tree must stay clean of any
  // domain vocabulary, including in test data. Access tags are opaque strings.
  doc = await handle.store.insertDocument(wctx, {
    title: 'Ops Runbook',
    blobStorageUri: 'file://ops-runbook',
    accessTags: ['team:ops'],
  });
  const paras = await handle.store.insertParagraphsBulk(wctx, [
    {
      id: asParagraphId(crypto.randomUUID()),
      documentId: doc.id,
      paragraphIndex: 0,
      text: 'The escalation procedure routes the task to the owner within ten days.',
      accessTags: ['team:ops'],
    },
  ]);
  const first = paras[0];
  if (!first) throw new Error('expected a persisted paragraph');
  para = first;
  entity = await handle.store.insertEntity(wctx, {
    type: 'Topic',
    properties: { name: 'escalation' },
    accessTags: ['team:ops'],
    provenance: { kind: 'manual', confidence: null },
  });
  // Embedding WITHOUT accessTags → migration 0001's trigger must copy them from
  // the paragraph (target_kind='paragraph'). Exercising the trigger is the point.
  await handle.store.upsertEmbedding(wctx, {
    targetKind: 'paragraph',
    targetId: para.id,
    modelId: MODEL,
    vector: vec(0.1),
  });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe('PGlite STOP gate — migrations + store run unchanged', () => {
  it('boots: all migrations 0000–0012 applied on PGlite without divergence', () => {
    expect(handle.store).toBeDefined();
    expect(handle.client).toBeDefined();
  });

  it('0012 applies on PGlite: config_cartridge_id column exists on tenant_settings', async () => {
    // The P4 migration must run UNCHANGED on PGlite (same migrations folder as
    // hosted Postgres). Prove the nullable opaque cartridge-id column exists.
    const cols = await handle.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_settings'`,
    );
    const names = (cols as unknown as { rows: Array<{ column_name: string }> }).rows.map(
      (r) => r.column_name,
    );
    expect(names).toContain('config_cartridge_id');
  });

  it('0011 applies on PGlite: document_duplicates table + new document columns exist', async () => {
    // The P3a migration must run UNCHANGED on PGlite (same migrations folder as
    // hosted Postgres). Prove the new table is queryable and the nullable
    // version/validity/sensitivity/simhash columns exist on documents.
    const dups = await handle.db.execute(sql`SELECT count(*)::int AS n FROM document_duplicates`);
    // PGlite's drizzle `execute` returns a { rows } result object.
    const dupRows = (dups as unknown as { rows: Array<{ n: number }> }).rows;
    expect(dupRows[0]?.n).toBe(0);
    const cols = await handle.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'`,
    );
    const names = (cols as unknown as { rows: Array<{ column_name: string }> }).rows.map(
      (r) => r.column_name,
    );
    for (const c of [
      'version_group_id',
      'version_seq',
      'supersedes_document_id',
      'valid_from',
      'valid_to',
      'sensitivity_class_id',
      'simhash',
    ]) {
      expect(names).toContain(c);
    }
  });

  it('CRUD + access-tag filter (TEXT[]/GIN + soft-delete columns): fail-closed', async () => {
    // visible with an overlapping tag
    expect(await handle.store.getEntity(regular(['team:ops']), entity.id)).not.toBeNull();
    // invisible with no overlap, and with the empty tag set ("see nothing")
    expect(await handle.store.getEntity(regular(['team:sales']), entity.id)).toBeNull();
    expect(await handle.store.getEntity(regular([]), entity.id)).toBeNull();
    // soft-delete excludes the row
    await handle.store.softDeleteEntity({ tenantId: TENANT, actor: ACTOR }, entity.id);
    expect(await handle.store.getEntity(regular(['team:ops']), entity.id)).toBeNull();
  });

  it('vector search (pgvector HNSW + ef_search) + 0001 trigger copied embedding tags', async () => {
    const hits = await handle.store.searchByVector(regular(['team:ops']), {
      modelId: MODEL,
      k: 5,
      queryVector: vec(0.1),
    });
    expect(hits.map((h) => h.targetId)).toContain(para.id);
    // The embedding had NO explicit accessTags — the trigger copied 'team:ops'
    // from the paragraph, so a non-overlapping caller sees nothing.
    const blind = await handle.store.searchByVector(regular(['team:sales']), {
      modelId: MODEL,
      k: 5,
      queryVector: vec(0.1),
    });
    expect(blind).toHaveLength(0);
  });

  it('keyword search (english tsvector + plainto_tsquery + ts_rank_cd)', async () => {
    const hits = await handle.store.searchByKeyword(regular(['team:ops']), {
      query: 'escalation',
      k: 5,
    });
    expect(hits.map((h) => h.targetId)).toContain(para.id);
    // access-filtered identically to every other read
    const blind = await handle.store.searchByKeyword(regular(['team:sales']), {
      query: 'escalation',
      k: 5,
    });
    expect(blind).toHaveLength(0);
  });

  it('bypass read writes internal_bypass_log; the tamper-evidence trigger blocks UPDATE', async () => {
    const before = await handle.db.select().from(internalBypassLog);
    const bypassCtx: ReadContext = {
      kind: 'bypass',
      tenantId: TENANT,
      bypass: internalBypass('stop-gate-test', 'verify bypass logging on PGlite'),
      actor: ACTOR,
    };
    // Bypass read sees the soft-deleted-then... use the document instead (entity
    // was soft-deleted above). Bypass drops the access filter, never the tenant.
    await handle.store.getDocument(bypassCtx, doc.id);
    const after = await handle.db.select().from(internalBypassLog);
    expect(after.length).toBe(before.length + 1);

    // The append-only trigger (migration 0000) must reject mutations — proving
    // PL/pgSQL trigger functions run on PGlite.
    await expect(
      handle.db.execute(sql`UPDATE internal_bypass_log SET reason = 'tampered'`),
    ).rejects.toThrow();
  });
});

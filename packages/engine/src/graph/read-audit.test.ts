// Per-read audit (F10/F26) — the two halves, proven separately:
//
// 1. PASS-THROUGH FIDELITY (AuditedGraphStore): permission-neutrality is the
//    invariant — every reader method hands the inner store the EXACT ctx/arg
//    references and returns the inner result reference unchanged, for regular,
//    bypass, and empty-tags contexts. Regular reads record ONE content-free
//    event; bypass reads record NOTHING (already in internal_bypass_log).
//
// 2. FAIL-OPEN WRITER (BatchedReadAuditWriter): an audit write never blocks or
//    fails a read — buffer overflow and write failure DROP with a visible
//    counter and a rate-limited warning. Flushes serialise on one chain (the
//    PGlite single-connection requirement), proven against a REAL in-memory
//    PGlite at the end (no Docker — unit suite).

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditEvents, tenants } from '../db/schema';
import { AuditedGraphStore } from './audited-graph-store';
import type { GraphStore } from './graph-store';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from './pglite-graph-store';
import {
  BatchedReadAuditWriter,
  type ReadAuditDb,
  type ReadAuditEvent,
  type ReadAuditSink,
  readAuditEnabled,
} from './read-audit';
import {
  type EntityId,
  type ReadContext,
  type RegularReadContext,
  type WriteContext,
  asActorId,
  asDocumentId,
  asEntityId,
  asParagraphId,
  asReviewItemId,
  asTenantId,
  internalBypass,
} from './types';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const ACTOR = asActorId('reader-oid');
const TAGS = ['t:alpha', 't:beta'];

const regular = (tags: readonly string[] = TAGS): RegularReadContext => ({
  kind: 'regular',
  tenantId: TENANT,
  accessTags: tags,
  actor: ACTOR,
});

const bypass = (): ReadContext => ({
  kind: 'bypass',
  tenantId: TENANT,
  bypass: internalBypass('read-audit.test', 'fidelity test'),
  actor: ACTOR,
});

class RecordingSink implements ReadAuditSink {
  readonly events: ReadAuditEvent[] = [];
  record(event: ReadAuditEvent): void {
    this.events.push(event);
  }
}

// One row per reader method: the args (beyond ctx), the canned inner result,
// and the expected audit row shape. Opaque object references are enough — the
// decorator must not inspect or copy results, only count them.
const ENTITY_ID = asEntityId('00000000-0000-0000-0000-00000000e001');
const EDGE_ID = '00000000-0000-0000-0000-00000000d001';
const DOC_ID = asDocumentId('00000000-0000-0000-0000-00000000f001');
const PARA_ID = asParagraphId('00000000-0000-0000-0000-00000000a001');
const REVIEW_ID = asReviewItemId('00000000-0000-0000-0000-00000000b001');

interface ReaderCase {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly result: unknown;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly resultCount: number;
}

const opaque = (label: string) => ({ __opaque: label });

const READER_CASES: readonly ReaderCase[] = [
  {
    method: 'getEntity',
    args: [ENTITY_ID],
    result: opaque('entity'),
    targetKind: 'entity',
    targetId: ENTITY_ID,
    resultCount: 1,
  },
  {
    method: 'getEntitiesByIds',
    args: [[ENTITY_ID, ENTITY_ID]],
    result: [opaque('e1'), opaque('e2'), opaque('e3')],
    targetKind: 'entity',
    targetId: null,
    resultCount: 3,
  },
  {
    method: 'findParagraphsPendingExtraction',
    args: [{ schemaHash: 'hash' }],
    result: [opaque('p1')],
    targetKind: 'paragraph',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'findEntities',
    args: [{ type: 'Thing' }],
    result: { items: [opaque('e1'), opaque('e2')], total: 17 },
    targetKind: 'entity',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'findEntitiesByParagraphIds',
    args: [[PARA_ID]],
    result: [opaque('e1')],
    targetKind: 'entity',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'getEdge',
    args: [EDGE_ID],
    result: null,
    targetKind: 'edge',
    targetId: EDGE_ID,
    resultCount: 0,
  },
  {
    method: 'findEdges',
    args: [{ type: 'related' }],
    result: { items: [], total: 0 },
    targetKind: 'edge',
    targetId: null,
    resultCount: 0,
  },
  {
    method: 'getNeighbours',
    args: [ENTITY_ID, { direction: 'both' }],
    result: { entities: [opaque('e1')], edges: [opaque('d1'), opaque('d2')] },
    targetKind: 'entity',
    targetId: ENTITY_ID,
    resultCount: 3,
  },
  {
    method: 'getDocument',
    args: [DOC_ID],
    result: opaque('doc'),
    targetKind: 'document',
    targetId: DOC_ID,
    resultCount: 1,
  },
  {
    method: 'getDocumentsByIds',
    args: [[DOC_ID]],
    result: [opaque('d1')],
    targetKind: 'document',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'getParagraph',
    args: [PARA_ID],
    result: null,
    targetKind: 'paragraph',
    targetId: PARA_ID,
    resultCount: 0,
  },
  {
    method: 'getParagraphsByIds',
    args: [[PARA_ID, PARA_ID]],
    result: [opaque('p1'), opaque('p2')],
    targetKind: 'paragraph',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'findParagraphsByDocument',
    args: [DOC_ID],
    result: [opaque('p1')],
    targetKind: 'document',
    targetId: DOC_ID,
    resultCount: 1,
  },
  {
    method: 'findDocumentByHash',
    args: ['sha256-of-content'],
    result: opaque('doc'),
    targetKind: 'document',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'findLatestLiveDocumentByExternalId',
    args: [{ connectorPackage: 'pkg', externalId: 'ext-1' }],
    result: null,
    targetKind: 'document',
    targetId: null,
    resultCount: 0,
  },
  {
    method: 'findDocumentFingerprints',
    args: [{ limit: 10 }],
    result: [opaque('f1'), opaque('f2')],
    targetKind: 'document',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'findDuplicatesForDocument',
    args: [DOC_ID],
    result: [],
    targetKind: 'document',
    targetId: DOC_ID,
    resultCount: 0,
  },
  {
    method: 'findDocuments',
    args: [{ limit: 5 }],
    result: { items: [opaque('d1')], total: 9 },
    targetKind: 'document',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'findRecentQueryEvents',
    args: [{ limit: 5 }],
    result: [opaque('q1')],
    targetKind: 'query_event',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'countQueryEvents',
    args: [{ since: new Date(0), byActor: true }],
    result: 42,
    targetKind: 'query_event',
    targetId: null,
    resultCount: 42,
  },
  {
    method: 'findExtractorVersion',
    args: [{ configurationId: 'c', schemaHash: 's', promptHash: 'p', modelId: 'm' }],
    result: opaque('ev'),
    targetKind: 'extractor_version',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'searchByVector',
    args: [{ modelId: 'm', k: 3, queryVector: [0.1, 0.2] }],
    result: [opaque('h1'), opaque('h2')],
    targetKind: 'embedding',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'getEmbeddingsByTargets',
    args: [{ targetKind: 'paragraph', targetIds: [PARA_ID], modelId: 'm' }],
    result: [opaque('emb')],
    targetKind: 'embedding',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'searchByKeyword',
    args: [{ query: 'secret terms', k: 5 }],
    result: [opaque('k1')],
    targetKind: 'paragraph',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'countCitationsByParagraph',
    args: [[PARA_ID]],
    result: new Map([[PARA_ID, 7]]),
    targetKind: 'paragraph',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'getReviewItem',
    args: [REVIEW_ID],
    result: opaque('item'),
    targetKind: 'review_item',
    targetId: REVIEW_ID,
    resultCount: 1,
  },
  {
    method: 'findPendingReviewItems',
    args: [{ limit: 10 }],
    result: [opaque('r1'), opaque('r2')],
    targetKind: 'review_item',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'getGraphStats',
    args: [],
    // resultCount = entitiesByType.length (the number of type buckets).
    result: { entitiesByType: [opaque('t1'), opaque('t2')], totalEntities: 3, totalEdges: 1 },
    targetKind: 'graph',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'listAuditEvents',
    args: [{ limit: 5 }],
    result: [opaque('au1')],
    targetKind: 'audit_event',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'listLlmCalls',
    args: [{ limit: 5 }],
    result: [opaque('lc1'), opaque('lc2')],
    targetKind: 'llm_call',
    targetId: null,
    resultCount: 2,
  },
  {
    method: 'summariseLlmCalls',
    args: [{}],
    // resultCount = byRegion.length.
    result: { byRegion: [opaque('reg1')], onDevice: {}, cloud: {}, stub: {} },
    targetKind: 'llm_call',
    targetId: null,
    resultCount: 1,
  },
  {
    method: 'countCitationsByDocument',
    args: [[DOC_ID]],
    result: new Map([[DOC_ID, 4]]),
    targetKind: 'document',
    targetId: null,
    resultCount: 1,
  },
];

// A stub inner store: every cased method resolves its canned result. Cast is
// safe — only the cased methods are invoked.
function stubInner(cases: readonly ReaderCase[]): {
  store: GraphStore;
  calls: Map<string, unknown[][]>;
} {
  const calls = new Map<string, unknown[][]>();
  const target: Record<string, unknown> = {};
  for (const c of cases) {
    target[c.method] = (...args: unknown[]) => {
      const seen = calls.get(c.method) ?? [];
      seen.push(args);
      calls.set(c.method, seen);
      return Promise.resolve(c.result);
    };
  }
  return { store: target as unknown as GraphStore, calls };
}

// Every GraphStoreWriter method (plus withTransaction) — pure delegation, no
// read-audit. Used by the structural coverage guard below.
const WRITER_METHODS = [
  'insertEntity',
  'insertEntitiesBulk',
  'updateEntity',
  'softDeleteEntity',
  'softDeleteExtractionsBySchema',
  'insertEdge',
  'insertEdgesBulk',
  'updateEdge',
  'softDeleteEdge',
  'insertDocument',
  'insertParagraphsBulk',
  'softDeleteDocument',
  'supersedeDocument',
  'recordDocumentDuplicate',
  'hardDeleteDocument',
  'recordIncompleteErasure',
  'upsertExtractorVersion',
  'upsertEmbedding',
  'insertLlmCall',
  'insertQueryEvent',
  'insertCitationEvents',
  'recordAuditEvent',
  'enqueueReviewItem',
  'resolveReviewItem',
  'deletePendingReviewItemsByTargets',
  'scrubResolvedReviewItems',
  'withTransaction',
];

describe('AuditedGraphStore pass-through fidelity (the reader surface)', () => {
  it('every decorator method is accounted for — a new reader method cannot escape the trail', () => {
    // STRUCTURAL guard, not a self-referential count: tsc forces the decorator
    // to IMPLEMENT a new GraphStoreReader method, and this test then fails
    // until the method gets a fidelity case (or is deliberately listed as a
    // writer) — an unaudited read path cannot land silently.
    const cased = new Set(READER_CASES.map((c) => c.method));
    expect(cased.size).toBe(READER_CASES.length); // no duplicate cases
    const methods = Object.getOwnPropertyNames(AuditedGraphStore.prototype).filter(
      (n) => n !== 'constructor' && n !== 'record', // record = the private audit helper
    );
    const unaccounted = methods.filter((m) => !cased.has(m) && !WRITER_METHODS.includes(m));
    expect(unaccounted).toEqual([]);
    for (const m of cased) {
      expect(methods).toContain(m);
    }
  });

  for (const c of READER_CASES) {
    it(`${c.method}: args/ctx/result untouched; one content-free event`, async () => {
      const { store: inner, calls } = stubInner(READER_CASES);
      const sink = new RecordingSink();
      const audited = new AuditedGraphStore(inner, sink) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const ctx = regular();
      const method = audited[c.method];
      if (!method) throw new Error(`decorator is missing ${c.method}`);

      const result = await method.call(audited, ctx, ...c.args);

      // Result is the inner reference, unchanged.
      expect(result).toBe(c.result);
      // The inner store received the EXACT ctx + argument references.
      const innerCalls = calls.get(c.method);
      expect(innerCalls).toHaveLength(1);
      const received = innerCalls?.[0] ?? [];
      expect(received[0]).toBe(ctx);
      c.args.forEach((arg, i) => {
        expect(received[i + 1]).toBe(arg);
      });
      // Exactly one event, content-free shape.
      expect(sink.events).toHaveLength(1);
      const event = sink.events[0];
      expect(event).toMatchObject({
        tenantId: TENANT,
        actor: ACTOR,
        action: `read.${c.method}`,
        targetKind: c.targetKind,
        targetId: c.targetId,
        resultCount: c.resultCount,
      });
      // A SNAPSHOT of the tags as used, never the caller's live reference — a
      // post-read mutation of the caller's array must not rewrite the trail.
      expect(event?.accessTagsUsed).toEqual(ctx.accessTags);
      expect(event?.accessTagsUsed).not.toBe(ctx.accessTags);
    });
  }

  it('an inner read rejection propagates unchanged and records NO event', async () => {
    const boom = new Error('db unavailable');
    const inner = { getEntity: () => Promise.reject(boom) } as unknown as GraphStore;
    const sink = new RecordingSink();
    const audited = new AuditedGraphStore(inner, sink);
    await expect(audited.getEntity(regular(), ENTITY_ID)).rejects.toBe(boom);
    expect(sink.events).toHaveLength(0); // no data returned → nothing to record
  });

  it('bypass reads record NOTHING (already in internal_bypass_log) and pass through untouched', async () => {
    const { store: inner, calls } = stubInner(READER_CASES);
    const sink = new RecordingSink();
    const audited = new AuditedGraphStore(inner, sink) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const ctx = bypass();
    for (const c of READER_CASES) {
      const result = await audited[c.method]?.call(audited, ctx, ...c.args);
      expect(result).toBe(c.result);
      expect(calls.get(c.method)?.[0]?.[0]).toBe(ctx);
    }
    expect(sink.events).toHaveLength(0);
  });

  it('an empty-tags regular context audits with accessTagsUsed = [] (sees-nothing is still a read)', async () => {
    const { store: inner } = stubInner(READER_CASES);
    const sink = new RecordingSink();
    const audited = new AuditedGraphStore(inner, sink);
    const ctx = regular([]);
    await audited.getEntity(ctx, ENTITY_ID);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.accessTagsUsed).toEqual([]);
  });

  it('withTransaction wraps the tx store: reads inside a transaction cannot escape auditing', async () => {
    const { store: txInner } = stubInner(READER_CASES);
    const inner = {
      withTransaction: (_ctx: WriteContext, fn: (tx: GraphStore) => Promise<unknown>) =>
        fn(txInner),
    } as unknown as GraphStore;
    const sink = new RecordingSink();
    const audited = new AuditedGraphStore(inner, sink);
    const wctx: WriteContext = { tenantId: TENANT, actor: ACTOR };

    await audited.withTransaction(wctx, async (tx) => {
      expect(tx).toBeInstanceOf(AuditedGraphStore);
      await tx.getEntity(regular(), ENTITY_ID);
      return null;
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.action).toBe('read.getEntity');
  });

  it('writes delegate verbatim with the exact references (no read-audit row)', async () => {
    const params = opaque('new-entity');
    const insertEntity = vi.fn((..._args: unknown[]) => Promise.resolve(opaque('inserted')));
    const inner = { insertEntity } as unknown as GraphStore;
    const sink = new RecordingSink();
    const audited = new AuditedGraphStore(inner, sink);
    const wctx: WriteContext = { tenantId: TENANT, actor: ACTOR };

    await audited.insertEntity(wctx, params as never);

    expect(insertEntity).toHaveBeenCalledTimes(1);
    expect(insertEntity.mock.calls[0]?.[0]).toBe(wctx);
    expect(insertEntity.mock.calls[0]?.[1]).toBe(params);
    expect(sink.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BatchedReadAuditWriter — fail-open with a visible counter.
// ---------------------------------------------------------------------------

function event(n: number): ReadAuditEvent {
  return {
    tenantId: TENANT,
    actor: ACTOR,
    action: `read.test${n}`,
    targetKind: 'entity',
    targetId: null,
    accessTagsUsed: TAGS,
    resultCount: n,
    occurredAt: new Date(),
  };
}

// A stub Drizzle handle whose insert either records or throws.
function stubDb(opts: { fail?: boolean } = {}) {
  const inserted: unknown[][] = [];
  let calls = 0;
  const db = {
    insert: () => ({
      values: (rows: unknown[]) => {
        calls += 1;
        if (opts.fail) throw new Error('db unavailable');
        inserted.push(rows);
        return Promise.resolve();
      },
    }),
  };
  return { db: db as unknown as ReadAuditDb, inserted, callCount: () => calls };
}

describe('BatchedReadAuditWriter', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('buffers, flushes at the size threshold, and writes content-free rows', async () => {
    const { db, inserted } = stubDb();
    const writer = new BatchedReadAuditWriter(db, { flushAtCount: 3, flushIntervalMs: 60_000 });
    writer.record(event(1));
    writer.record(event(2));
    expect(inserted).toHaveLength(0); // below threshold — still buffered
    writer.record(event(3)); // threshold → async flush
    await writer.flush();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(3);
    const row = (inserted[0] as Record<string, unknown>[])[0];
    expect(row).toMatchObject({
      tenantId: TENANT,
      actor: ACTOR,
      action: 'read.test1',
      details: { resultCount: 1 },
    });
    // The row carries ONLY the audit columns — no content fields can sneak in.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'accessTagsUsed',
      'action',
      'actor',
      'details',
      'id',
      'occurredAt',
      'targetId',
      'targetKind',
      'tenantId',
    ]);
    await writer.close();
  });

  it('flushes on the interval without any explicit flush call', async () => {
    vi.useFakeTimers();
    try {
      const { db, inserted } = stubDb();
      const writer = new BatchedReadAuditWriter(db, { flushAtCount: 100, flushIntervalMs: 1_000 });
      writer.record(event(1));
      expect(inserted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(inserted).toHaveLength(1);
      await writer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops on buffer overflow with a visible counter — never throws, never blocks', async () => {
    const { db } = stubDb();
    const writer = new BatchedReadAuditWriter(db, {
      maxBuffer: 2,
      flushAtCount: 100,
      flushIntervalMs: 60_000,
    });
    writer.record(event(1));
    writer.record(event(2));
    writer.record(event(3)); // over maxBuffer → dropped
    writer.record(event(4)); // dropped
    expect(writer.dropped).toBe(2);
    await writer.close();
  });

  it('a failing writer NEVER fails the read path: drops the batch, counts, rate-limits the warning', async () => {
    const { db } = stubDb({ fail: true });
    const writer = new BatchedReadAuditWriter(db, {
      flushAtCount: 100,
      flushIntervalMs: 60_000,
      warnIntervalMs: 60_000,
    });
    writer.record(event(1));
    writer.record(event(2));
    await expect(writer.flush()).resolves.toBeUndefined(); // never rejects
    expect(writer.dropped).toBe(2);
    writer.record(event(3));
    await writer.flush();
    expect(writer.dropped).toBe(3);
    // Two drop occasions, ONE warning — rate-limited.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await writer.close();
  });

  it('close() flushes the tail and further records are dropped (counted)', async () => {
    const { db, inserted } = stubDb();
    const writer = new BatchedReadAuditWriter(db, { flushAtCount: 100, flushIntervalMs: 60_000 });
    writer.record(event(1));
    await writer.close();
    expect(inserted).toHaveLength(1);
    writer.record(event(2));
    expect(writer.dropped).toBe(1);
  });
});

describe('readAuditEnabled', () => {
  it('defaults ON; only an explicit false disables', () => {
    expect(readAuditEnabled({})).toBe(true);
    expect(readAuditEnabled({ MUNIN_READ_AUDIT: 'true' })).toBe(true);
    expect(readAuditEnabled({ MUNIN_READ_AUDIT: 'yes-typo' })).toBe(true);
    expect(readAuditEnabled({ MUNIN_READ_AUDIT: 'false' })).toBe(false);
    expect(readAuditEnabled({ MUNIN_READ_AUDIT: 'FALSE' })).toBe(false);
  });

  it('REFUSES false under NODE_ENV=production without the explicit override (compliance control)', () => {
    expect(() => readAuditEnabled({ MUNIN_READ_AUDIT: 'false', NODE_ENV: 'production' })).toThrow(
      /refused under NODE_ENV=production/,
    );
    // The documented, explicit deployment decision is honoured.
    expect(
      readAuditEnabled({
        MUNIN_READ_AUDIT: 'false',
        NODE_ENV: 'production',
        MUNIN_READ_AUDIT_ALLOW_PROD_OFF: 'true',
      }),
    ).toBe(false);
    // ON in production needs no override.
    expect(readAuditEnabled({ NODE_ENV: 'production' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PGlite (single in-process connection): the audited store + batched writer
// work end-to-end, and overlapping flushes serialise without loss. No Docker —
// this boots the same in-memory PGlite the local runtime uses.
// ---------------------------------------------------------------------------

describe('read audit on PGlite (local runtime)', () => {
  let handle: PgliteGraphStoreHandle;
  let writer: BatchedReadAuditWriter;
  let audited: AuditedGraphStore;
  let entityId: EntityId;

  beforeAll(async () => {
    handle = await createPgliteGraphStore({}); // in-memory
    await handle.db.insert(tenants).values({ id: TENANT, name: 'Audit Tenant' });
    const wctx: WriteContext = { tenantId: TENANT, actor: ACTOR };
    entityId = (
      await handle.store.insertEntity(wctx, {
        type: 'Thing',
        properties: { name: 'audited-thing' },
        accessTags: TAGS,
        provenance: { kind: 'manual', confidence: null },
      })
    ).id;
    // flushAtCount 1: EVERY record schedules its own flush — overlapping
    // flushes on the single PGlite connection must serialise, not deadlock.
    writer = new BatchedReadAuditWriter(handle.db, { flushAtCount: 1, flushIntervalMs: 60_000 });
    audited = new AuditedGraphStore(handle.store, writer);
  });

  afterAll(async () => {
    await writer.close();
    await handle.close();
  });

  it('records real audit_events rows; flushes serialise; nothing is lost or duplicated', async () => {
    const ctx = regular();
    await Promise.all([
      audited.getEntity(ctx, entityId),
      audited.getEntitiesByIds(ctx, [entityId]),
      audited.findEntities(ctx, {}),
    ]);
    await writer.flush();

    const rows = await handle.db.select().from(auditEvents).where(eq(auditEvents.tenantId, TENANT));
    const readRows = rows.filter((r) => r.action.startsWith('read.'));
    expect(readRows).toHaveLength(3);
    expect(new Set(readRows.map((r) => r.action))).toEqual(
      new Set(['read.getEntity', 'read.getEntitiesByIds', 'read.findEntities']),
    );
    for (const row of readRows) {
      expect(row.actor).toBe(ACTOR);
      expect(row.accessTagsUsed).toEqual(TAGS);
      expect(row.details).toEqual({ resultCount: 1 });
    }
    expect(writer.dropped).toBe(0);
  });

  it('audited reads return identical results to the raw store (decorator widens nothing)', async () => {
    const narrow = regular(['t:other']); // holds neither seeded tag
    const [rawVisible, auditedVisible, rawHidden, auditedHidden] = await Promise.all([
      handle.store.getEntity(regular(), entityId),
      audited.getEntity(regular(), entityId),
      handle.store.getEntity(narrow, entityId),
      audited.getEntity(narrow, entityId),
    ]);
    expect(auditedVisible?.id).toBe(rawVisible?.id);
    expect(rawHidden).toBeNull();
    expect(auditedHidden).toBeNull(); // invisible stays invisible through the decorator
  });
});

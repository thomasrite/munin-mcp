// ContextRetriever — unit. Exercises the public surface (open vs entity-centric
// routing, disambiguation present/pick, gatherSources) and the permission
// invariant: every read runs under the caller's exact ReadContext (no bypass,
// no mutation). Pure routing + a focused in-memory fake store; integration
// no-leak coverage lives in the permission matrix + query-pipeline int tests.

import type { EntityResolutionHints } from '@muninhq/shared';
import { describe, expect, it } from 'vitest';

import type { GraphStore } from '../graph/graph-store';
import {
  type Document,
  type Entity,
  type EntityId,
  type Paragraph,
  type ParagraphId,
  type ReadContext,
  asActorId,
  asDocumentId,
  asEntityId,
  asExtractorVersionId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  ProviderCapabilities,
  RerankProvider,
} from '../providers';
import { ContextRetriever } from './context-retriever';
import type { GatherTarget } from './gather';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const ACTOR = asActorId('test');
const READ_CTX: ReadContext = {
  kind: 'regular',
  tenantId: TENANT,
  accessTags: ['t:public'],
  actor: ACTOR,
};

const HINTS = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['ref'] }],
]);

const CAPS: ProviderCapabilities = {
  promptCaching: false,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

// A fixed-vector embedding provider — the fake store ignores the vector and
// returns configured hits, so the value is irrelevant; only the call matters.
function fakeEmbedding(): EmbeddingProvider {
  return {
    id: 'fake-embed',
    capabilities: CAPS,
    dimensions: 3,
    modelId: 'fake-embed-1',
    async embed(_req: EmbedRequest): Promise<EmbedResponse> {
      return { vectors: [[0.1, 0.2, 0.3]], inputTokens: 1, modelId: 'fake-embed-1' };
    },
  };
}

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-0000-0000-${seq.toString(16).padStart(12, '0')}`;
}

interface Backing {
  readonly entities: Map<string, Entity>;
  readonly paragraphs: Map<string, Paragraph>;
  readonly documents: Map<string, Document>;
}

// Create an Employee entity backed by its own paragraph + document, so a gather
// of it materialises exactly one source.
function employee(b: Backing, fullName: string, ref: string | undefined): Entity {
  const id = asEntityId(uuid());
  const docId = asDocumentId(uuid());
  const paraId = asParagraphId(uuid());
  const now = new Date();
  b.documents.set(docId, {
    id: docId,
    tenantId: TENANT,
    externalId: null,
    connectorPackage: null,
    title: `Doc for ${fullName}`,
    mimeType: null,
    byteSize: null,
    sha256: null,
    blobStorageUri: 'blob://x',
    sourceModifiedAt: null,
    versionGroupId: null,
    versionSeq: null,
    supersedesDocumentId: null,
    validFrom: null,
    validTo: null,
    sensitivityClassId: null,
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  b.paragraphs.set(paraId, {
    id: paraId,
    tenantId: TENANT,
    documentId: docId,
    paragraphIndex: 0,
    page: 1,
    text: `${fullName} has a record on file.`,
    structure: {},
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const entity: Entity = {
    id,
    tenantId: TENANT,
    type: 'Employee',
    properties: { fullName, ...(ref ? { ref } : {}) },
    accessTags: ['t:public'],
    provenance: {
      kind: 'document_extract',
      documentId: docId,
      paragraphId: paraId,
      extractorVersionId: asExtractorVersionId(uuid()),
      confidence: 1,
    },
    createdBy: ACTOR,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  b.entities.set(id, entity);
  return entity;
}

interface FakeStore {
  readonly store: GraphStore;
  // Every ReadContext seen by a reader method (for the permission invariant).
  readonly seenCtx: ReadContext[];
}

// A focused in-memory fake: implements only the reader methods the retriever
// calls, records the ctx of each, and supports the vector hits + entity filters
// the open and gather paths need.
function fakeStore(
  b: Backing,
  opts: {
    vectorHitParagraphIds?: readonly ParagraphId[];
    keywordHitParagraphIds?: readonly ParagraphId[];
  } = {},
): FakeStore {
  const seenCtx: ReadContext[] = [];
  const rec = (ctx: ReadContext) => {
    seenCtx.push(ctx);
  };
  const allEmployees = () => [...b.entities.values()].filter((e) => e.type === 'Employee');

  const partial = {
    async searchByVector(ctx: ReadContext) {
      rec(ctx);
      // Fixed within-threshold distance; the hybrid fusion ranks by list POSITION
      // (array order), not the distance value, so equal distances are fine.
      return (opts.vectorHitParagraphIds ?? []).map((pid) => ({
        embeddingId: asEntityId(uuid()) as never,
        targetKind: 'paragraph' as const,
        targetId: pid as string,
        distance: 0.12,
        accessTags: ['t:public'],
      }));
    },
    async searchByKeyword(ctx: ReadContext) {
      rec(ctx);
      return (opts.keywordHitParagraphIds ?? []).map((pid, i) => ({
        targetKind: 'paragraph' as const,
        targetId: pid as string,
        rank: 1 - i * 0.1, // descending lexical relevance by rank
        accessTags: ['t:public'],
      }));
    },
    async findEntities(
      ctx: ReadContext,
      query: {
        types?: readonly string[];
        propertyEquals?: { property: string; value: string };
        limit?: number;
      },
    ) {
      rec(ctx);
      let items = allEmployees();
      if (query.types) items = items.filter((e) => query.types?.includes(e.type));
      if (query.propertyEquals) {
        const { property, value } = query.propertyEquals;
        items = items.filter((e) => e.properties[property] === value);
      }
      const total = items.length;
      // Honour the limit but report the FULL count, so the retriever's "page
      // truncated → fall back to open" honesty guard is exercisable.
      const limited = query.limit !== undefined ? items.slice(0, query.limit) : items;
      return { items: limited, total };
    },
    async getEntitiesByIds(ctx: ReadContext, ids: readonly EntityId[]) {
      rec(ctx);
      return ids.map((id) => b.entities.get(id)).filter((e): e is Entity => e !== undefined);
    },
    async findEntitiesByParagraphIds(ctx: ReadContext) {
      rec(ctx);
      return []; // no graph expansion in these unit fixtures
    },
    async getNeighbours(ctx: ReadContext) {
      rec(ctx);
      return { entities: [], edges: [] };
    },
    async getParagraphsByIds(ctx: ReadContext, ids: readonly ParagraphId[]) {
      rec(ctx);
      return ids.map((id) => b.paragraphs.get(id)).filter((p): p is Paragraph => p !== undefined);
    },
    async getDocumentsByIds(ctx: ReadContext, ids: readonly string[]) {
      rec(ctx);
      return ids.map((id) => b.documents.get(id)).filter((d): d is Document => d !== undefined);
    },
  };
  return { store: partial as unknown as GraphStore, seenCtx };
}

function emptyBacking(): Backing {
  return { entities: new Map(), paragraphs: new Map(), documents: new Map() };
}

describe('ContextRetriever — open vector path', () => {
  it('no identity layer → vector context with a ranked source', async () => {
    const b = emptyBacking();
    const e = employee(b, 'Helena Voss', 'R1'); // gives us a backed paragraph to hit
    const paraId = e.provenance.kind === 'document_extract' ? e.provenance.paragraphId : null;
    const { store } = fakeStore(b, { vectorHitParagraphIds: paraId ? [paraId] : [] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'what is the absence policy?',
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.method).toBe('vector');
    expect(ctx.classification.kind).toBe('open');
    expect(ctx.subject).toBeNull();
    expect(ctx.completeness).toBeNull(); // open path never asserts completeness
    expect(ctx.message).not.toBeNull();
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources[0]?.method).toBe('vector');
    expect(ctx.sources[0]?.distance).toBeCloseTo(0.12);
    expect(ctx.sources[0]?.sourceId).toBe('P1');
  });

  it('no visible vector hits → no message, no sources (caller declines)', async () => {
    const b = emptyBacking();
    const { store } = fakeStore(b, { vectorHitParagraphIds: [] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, { question: 'anything?' });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.message).toBeNull();
    expect(ctx.sources).toHaveLength(0);
  });

  it('PERMISSION INVARIANT: every read runs under the caller ReadContext (no bypass, no mutation)', async () => {
    const b = emptyBacking();
    const e = employee(b, 'Helena Voss', 'R1');
    const paraId = e.provenance.kind === 'document_extract' ? e.provenance.paragraphId : null;
    const { store, seenCtx } = fakeStore(b, { vectorHitParagraphIds: paraId ? [paraId] : [] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    await retriever.retrieveContext(READ_CTX, { question: 'policy?' });

    expect(seenCtx.length).toBeGreaterThan(0);
    for (const c of seenCtx) {
      expect(c.kind).toBe('regular'); // never a bypass context
      expect(c).toBe(READ_CTX); // the SAME object — not re-derived or widened
    }
  });
});

// The source paragraph backing an employee fixture (each employee owns one).
function paraIdOf(e: Entity): ParagraphId {
  if (e.provenance.kind !== 'document_extract') throw new Error('fixture has no paragraph');
  return e.provenance.paragraphId;
}

// A fake reranker that records the candidate ids it was handed and returns a
// fixed promotion order (intersected with the candidates it actually received).
function fakeRerank(order: readonly string[], seen: { ids: string[] }): RerankProvider {
  return {
    id: 'fake-rerank',
    modelId: 'fake',
    maxDocuments: 100,
    async rerank(req) {
      seen.ids = req.documents.map((d) => d.id);
      const have = new Set(req.documents.map((d) => d.id));
      const ranking = order
        .filter((id) => have.has(id))
        .slice(0, req.topK)
        .map((id, i) => ({ id, score: 100 - i }));
      return { ranking, modelId: 'fake' };
    },
  };
}

describe('ContextRetriever — reranker (open path)', () => {
  it('promotes a reranked candidate to the top of the grounded set', async () => {
    const b = emptyBacking();
    const a = employee(b, 'Anna Adeyemi', 'R1');
    const c = employee(b, 'Carl Cole', 'R2');
    const d = employee(b, 'Dana Donne', 'R3');
    const pA = a.provenance.kind === 'document_extract' ? a.provenance.paragraphId : null;
    const pC = c.provenance.kind === 'document_extract' ? c.provenance.paragraphId : null;
    const pD = d.provenance.kind === 'document_extract' ? d.provenance.paragraphId : null;
    const { store } = fakeStore(b, {
      vectorHitParagraphIds: [pA, pC, pD].filter((x): x is ParagraphId => x !== null),
    });
    const seen = { ids: [] as string[] };
    // Fused order would be A, C, D — the reranker promotes D then A.
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
      keywordWeight: 0, // pure vector → fused order is the vector order
      rerankProvider: fakeRerank([String(pD), String(pA)], seen),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, { question: 'who is Dana Donne?' });
    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.sources[0]?.paragraph.id).toBe(pD); // promoted to the top
    expect(ctx.sources[1]?.paragraph.id).toBe(pA);
    // The reranker only ever saw the permission-filtered, materialised candidates.
    expect(seen.ids.sort()).toEqual([String(pA), String(pC), String(pD)].sort());
  });

  it('falls back to the fused order when the reranker throws (best-effort)', async () => {
    const b = emptyBacking();
    const a = employee(b, 'Anna Adeyemi', 'R1');
    const pA = a.provenance.kind === 'document_extract' ? a.provenance.paragraphId : null;
    const { store } = fakeStore(b, {
      vectorHitParagraphIds: pA ? [pA] : [],
    });
    const throwing: RerankProvider = {
      id: 'boom',
      modelId: 'boom',
      maxDocuments: 100,
      async rerank() {
        throw new Error('rerank unavailable');
      },
    };
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
      keywordWeight: 0,
      rerankProvider: throwing,
    });
    const ctx = await retriever.retrieveContext(READ_CTX, { question: 'q' });
    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.sources.length).toBe(1); // query still answered from the fused order
    expect(ctx.sources[0]?.paragraph.id).toBe(pA);
  });
});

describe('ContextRetriever — hybrid (vector + keyword) open path', () => {
  it('a keyword-only needle that vector misses is retrieved — and marked method "keyword"', async () => {
    const b = emptyBacking();
    const needle = paraIdOf(employee(b, 'Featherstonehaugh', 'N1')); // proper noun vector ranks poorly
    const d1 = paraIdOf(employee(b, 'Distractor One', 'D1'));
    const d2 = paraIdOf(employee(b, 'Distractor Two', 'D2'));
    // Vector returns only the distractors (misses the needle); keyword finds it.
    const { store } = fakeStore(b, {
      vectorHitParagraphIds: [d1, d2],
      keywordHitParagraphIds: [needle],
    });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, { question: 'Featherstonehaugh' });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    const ids = ctx.sources.map((s) => s.paragraph.id);
    expect(ids).toContain(needle); // the lift: vector alone would have missed it
    const needleSrc = ctx.sources.find((s) => s.paragraph.id === needle);
    expect(needleSrc?.method).toBe('keyword');
    expect(needleSrc?.distance).toBeNull(); // keyword-only → no vector distance
    // The vector distractors are still present and marked 'vector'.
    expect(ctx.sources.find((s) => s.paragraph.id === d1)?.method).toBe('vector');
  });

  it('keywordWeight = 0 is vector-only: the keyword-only needle is NOT retrieved (before)', async () => {
    const b = emptyBacking();
    const needle = paraIdOf(employee(b, 'Featherstonehaugh', 'N1'));
    const d1 = paraIdOf(employee(b, 'Distractor One', 'D1'));
    const { store } = fakeStore(b, {
      vectorHitParagraphIds: [d1],
      keywordHitParagraphIds: [needle],
    });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'Featherstonehaugh',
      options: { keywordWeight: 0 },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    const ids = ctx.sources.map((s) => s.paragraph.id);
    expect(ids).not.toContain(needle); // vector-only misses the proper noun
    expect(ids).toContain(d1);
    expect(ctx.sources.every((s) => s.method === 'vector')).toBe(true);
  });

  it('PERMISSION INVARIANT holds on the keyword path too (no bypass)', async () => {
    const b = emptyBacking();
    const needle = paraIdOf(employee(b, 'Featherstonehaugh', 'N1'));
    const d1 = paraIdOf(employee(b, 'Distractor One', 'D1'));
    const { store, seenCtx } = fakeStore(b, {
      vectorHitParagraphIds: [d1],
      keywordHitParagraphIds: [needle],
    });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    await retriever.retrieveContext(READ_CTX, { question: 'Featherstonehaugh' });

    // searchByKeyword is among the recorded reads, and every read used the caller ctx.
    expect(seenCtx.length).toBeGreaterThan(0);
    for (const c of seenCtx) {
      expect(c.kind).toBe('regular');
      expect(c).toBe(READ_CTX);
    }
  });
});

// Seed a bare paragraph (its own doc) with a specific createdAt, for recency tests.
function seedPara(b: Backing, text: string, ageDays: number): ParagraphId {
  const id = asParagraphId(uuid());
  const docId = asDocumentId(uuid());
  const now = Date.now();
  const createdAt = new Date(now - ageDays * 86_400_000);
  b.documents.set(docId, {
    id: docId,
    tenantId: TENANT,
    externalId: null,
    connectorPackage: null,
    title: `Doc ${text.slice(0, 12)}`,
    mimeType: null,
    byteSize: null,
    sha256: null,
    blobStorageUri: 'blob://x',
    sourceModifiedAt: null,
    versionGroupId: null,
    versionSeq: null,
    supersedesDocumentId: null,
    validFrom: null,
    validTo: null,
    sensitivityClassId: null,
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  b.paragraphs.set(id, {
    id,
    tenantId: TENANT,
    documentId: docId,
    paragraphIndex: 0,
    page: 1,
    text,
    structure: {},
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  return id;
}

describe('ContextRetriever — recency ranking signal', () => {
  it('with recency OFF (default), a stale doc ranked first by vector stays first', async () => {
    const b = emptyBacking();
    const stale = seedPara(b, 'the leave entitlement is twenty days', 2000); // ~5.5y old
    const fresh = seedPara(b, 'the leave entitlement is twenty five days', 1);
    // Vector ranks the stale doc first (it is the more vector-similar phrasing).
    const { store } = fakeStore(b, { vectorHitParagraphIds: [stale, fresh] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, { question: 'leave entitlement?' });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    const ids = ctx.sources.map((s) => s.paragraph.id);
    expect(ids[0]).toBe(stale); // no recency effect → vector order preserved
    expect(ids).toContain(fresh);
  });

  it('with recency ON, the current doc outranks the superseded one — which stays reachable', async () => {
    const b = emptyBacking();
    const stale = seedPara(b, 'the leave entitlement is twenty days', 2000);
    const fresh = seedPara(b, 'the leave entitlement is twenty five days', 1);
    // SAME corpus + SAME vector order (stale first) as the OFF case above.
    const { store } = fakeStore(b, { vectorHitParagraphIds: [stale, fresh] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'leave entitlement?',
      options: { keywordWeight: 0, recencyHalfLifeDays: 180 },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    const ids = ctx.sources.map((s) => s.paragraph.id);
    // Recency flips the order: current first, superseded demoted…
    expect(ids[0]).toBe(fresh);
    // …but NOT dropped — a soft signal, never a hard filter.
    expect(ids).toContain(stale);
  });

  it('recency is a soft signal: a stale doc is never removed, only re-ordered', async () => {
    const b = emptyBacking();
    const stale = seedPara(b, 'historic precedent on overtime pay', 4000);
    const { store } = fakeStore(b, { vectorHitParagraphIds: [stale] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'overtime pay precedent',
      options: { recencyHalfLifeDays: 90 },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    // The only relevant doc is ancient, but it is still retrieved (reachable).
    expect(ctx.sources.map((s) => s.paragraph.id)).toContain(stale);
  });
});

describe('ContextRetriever — entity-centric path', () => {
  it('a single named subject → gather context with a completeness disposition', async () => {
    const b = emptyBacking();
    employee(b, 'Helena Voss', 'R1');
    employee(b, 'Adrian Cole', 'R2');
    const { store } = fakeStore(b);
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'Helena Voss absence',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.method).toBe('gather');
    expect(ctx.classification.kind).toBe('entity-centric');
    expect(ctx.subject?.toLowerCase()).toContain('voss');
    expect(ctx.completeness).not.toBeNull();
    expect(ctx.completeness?.subject.toLowerCase()).toContain('voss');
    // Keyed, no unlinked remainder → complete-by-construction.
    expect(ctx.completeness?.mayHaveUnlinkedRecords).toBe(false);
    expect(ctx.sources.every((s) => s.method === 'gather')).toBe(true);
    expect(ctx.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('per-request options (maxParagraphs) are honoured on the gather path', async () => {
    const b = emptyBacking();
    // Two same-name + same-key rows → M1.1 merges them into ONE cluster; the
    // key-gather then materialises BOTH records (2 source paragraphs).
    employee(b, 'Helena Voss', 'SHARED');
    employee(b, 'Helena Voss', 'SHARED');
    const { store } = fakeStore(b);
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });
    const identity = { subjectTypes: ['Employee'], hintsByType: HINTS };

    const full = await retriever.retrieveContext(READ_CTX, {
      question: 'Helena Voss absence',
      identity,
    });
    expect(full.kind).toBe('context');
    if (full.kind !== 'context') return;
    expect(full.method).toBe('gather');
    expect(full.sources.length).toBe(2);

    // The per-request override must reach the gather budgeting (obs-2 regression guard).
    const capped = await retriever.retrieveContext(READ_CTX, {
      question: 'Helena Voss absence',
      identity,
      options: { maxParagraphs: 1 },
    });
    expect(capped.kind).toBe('context');
    if (capped.kind !== 'context') return;
    expect(capped.sources.length).toBe(1);
  });

  it('a same-name collision → disambiguation (present), not a silent pick', async () => {
    const b = emptyBacking();
    // Two distinct Mark Davies (different exact keys → two clusters).
    employee(b, 'Mark Davies', 'KEY-A');
    employee(b, 'Mark Davies', 'KEY-B');
    employee(b, 'Helena Voss', 'R1');
    const { store } = fakeStore(b);
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'what is on file about Mark Davies?',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });

    expect(ctx.kind).toBe('disambiguation');
    if (ctx.kind !== 'disambiguation') return;
    expect(ctx.subject.toLowerCase()).toContain('davies');
    expect(ctx.group.candidates.length).toBeGreaterThanOrEqual(2);
    expect(ctx.entitiesById.size).toBeGreaterThan(0);
    expect(ctx.pickWasStale).toBe(false);
  });

  it('a pick token re-gathers the chosen candidate', async () => {
    const b = emptyBacking();
    employee(b, 'Mark Davies', 'KEY-A');
    employee(b, 'Mark Davies', 'KEY-B');
    const { store } = fakeStore(b);
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const first = await retriever.retrieveContext(READ_CTX, {
      question: 'about Mark Davies',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });
    expect(first.kind).toBe('disambiguation');
    if (first.kind !== 'disambiguation') return;
    const token = first.group.candidates[0]?.token;
    expect(token).toBeDefined();
    if (token === undefined) return;

    const picked = await retriever.retrieveContext(READ_CTX, {
      question: 'about Mark Davies',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS, pick: token },
    });
    expect(picked.kind).toBe('context');
    if (picked.kind !== 'context') return;
    expect(picked.method).toBe('gather');
    expect(picked.subject).not.toBeNull();
    expect((picked.subject ?? '').toLowerCase()).toContain('davies');
  });

  it('a stale pick token re-presents the candidates (pickWasStale)', async () => {
    const b = emptyBacking();
    employee(b, 'Mark Davies', 'KEY-A');
    employee(b, 'Mark Davies', 'KEY-B');
    const { store } = fakeStore(b);
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'about Mark Davies',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS, pick: 'no-such-token' },
    });

    expect(ctx.kind).toBe('disambiguation');
    if (ctx.kind !== 'disambiguation') return;
    expect(ctx.pickWasStale).toBe(true);
  });

  it('a bare-surname query over MULTIPLE same-surname people uses open, never a silent single-gather', async () => {
    const b = emptyBacking();
    // Two DISTINCT people sharing surname "Voss". A bare-surname query names no one
    // subject unambiguously, so the SAFE end-to-end outcome is the open path (which
    // makes NO per-person completeness claim) — never silently gathering whichever
    // sorted first and asserting it is complete. (The shared resolver's own
    // `ambiguous` arm is unit-tested in resolve-target.test.ts; the entity path
    // maps both `ambiguous` and `not-found` to this same open fallback.)
    employee(b, 'Helena Voss', 'R1');
    employee(b, 'Adrian Voss', 'R2');
    const { store } = fakeStore(b, { vectorHitParagraphIds: [] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'tell me about Voss',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.method).toBe('vector'); // open path, not a gather
    expect(ctx.completeness).toBeNull(); // never asserts completeness for one of several
  });

  it('empty subject types → falls back to the open vector path', async () => {
    const b = emptyBacking();
    const { store } = fakeStore(b, { vectorHitParagraphIds: [] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'Helena Voss',
      identity: { subjectTypes: [], hintsByType: HINTS },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.method).toBe('vector');
  });

  it('a truncated subject page is honest: falls back to open rather than partial-gather', async () => {
    const b = emptyBacking();
    employee(b, 'Helena Voss', 'R1');
    employee(b, 'Adrian Cole', 'R2');
    const { store } = fakeStore(b, { vectorHitParagraphIds: [] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    // entityPageLimit 1 with 2 visible subjects → page.total (2) > page.items (1).
    // The retriever must NOT resolve on a truncated set (it could miss the subject
    // or partial-gather a cluster); it falls back to the open vector path, which
    // claims no completeness.
    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'Helena Voss absence',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS, entityPageLimit: 1 },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.method).toBe('vector');
    expect(ctx.classification.kind).toBe('open');
  });
});

describe('ContextRetriever — hybrid gather ∪ open (entity-centric)', () => {
  it('surfaces a question-relevant doc the identity-gather does not reach, keeping completeness', async () => {
    const b = emptyBacking();
    const helena = employee(b, 'Helena Voss', 'R1'); // gather reaches her own record
    const gatherPara = paraIdOf(helena);
    // The answer doc: a standalone paragraph NOT linked to Helena's entity, so
    // gather-by-identity never reaches it — but content retrieval does. This is the
    // scale failure mode (sparse keys scatter a person's records); the hybrid union
    // + rerank must still surface it.
    const answer = seedPara(b, 'Helena Voss grievance outcome: upheld', 10);
    const seen = { ids: [] as string[] };
    const { store } = fakeStore(b, { vectorHitParagraphIds: [answer] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
      keywordWeight: 0,
      rerankProvider: fakeRerank([String(answer)], seen), // judge promotes the answer doc
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'what was the outcome of Helena Voss grievance?',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });

    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    expect(ctx.method).toBe('gather'); // still the identity path (completeness preserved)
    const ids = ctx.sources.map((s) => String(s.paragraph.id));
    expect(ids).toContain(String(answer)); // the hybrid lift — gather alone would miss it
    expect(ids).toContain(String(gatherPara)); // identity completeness still present
    // The reranker saw the UNION (gathered record + open hit), all permission-filtered.
    expect(seen.ids).toEqual(expect.arrayContaining([String(gatherPara), String(answer)]));
    expect(ctx.completeness?.subject.toLowerCase()).toContain('voss');
  });

  it('PERMISSION INVARIANT: the open half of the gather union reads under the caller ctx', async () => {
    const b = emptyBacking();
    employee(b, 'Helena Voss', 'R1');
    const answer = seedPara(b, 'Helena Voss grievance outcome: upheld', 10);
    const { store, seenCtx } = fakeStore(b, { vectorHitParagraphIds: [answer] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    await retriever.retrieveContext(READ_CTX, {
      question: 'what was the outcome of Helena Voss grievance?',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });

    expect(seenCtx.length).toBeGreaterThan(0);
    for (const c of seenCtx) {
      expect(c.kind).toBe('regular'); // never a bypass on the gather-union open read
      expect(c).toBe(READ_CTX);
    }
  });
});

describe('ContextRetriever.gatherSources', () => {
  it('materialises a target into ranked gather sources with completeness', async () => {
    const b = emptyBacking();
    const e = employee(b, 'Helena Voss', 'R1');
    const { store } = fakeStore(b);
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const target: GatherTarget = {
      entityType: 'Employee',
      keyProperty: 'ref',
      keyValue: 'R1',
      clusterMemberIds: [e.id],
    };
    const out = await retriever.gatherSources(READ_CTX, target);

    expect(out.sources.length).toBe(1);
    expect(out.recordCount).toBe(1);
    expect(out.sources[0]?.sourceId).toBe('P1');
    expect(out.sources[0]?.method).toBe('gather');
    expect(out.sources[0]?.distance).toBeNull();
    expect(out.mayHaveUnlinkedRecords).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Supersession demote + F40 recency-by-sourceModifiedAt (P3a).
// ---------------------------------------------------------------------------

// A bare document + one paragraph with caller-controlled dates / validTo, for
// the open-path ranking signals. No entity (open path needs none here).
function docPara(
  b: Backing,
  opts: {
    sourceModifiedAt: Date | null;
    validTo: Date | null;
    paraCreatedAt: Date;
    text: string;
  },
): { docId: string; paraId: ParagraphId } {
  const docId = asDocumentId(uuid());
  const paraId = asParagraphId(uuid());
  b.documents.set(docId, {
    id: docId,
    tenantId: TENANT,
    externalId: null,
    connectorPackage: null,
    title: `Doc ${docId}`,
    mimeType: null,
    byteSize: null,
    sha256: null,
    blobStorageUri: 'blob://x',
    sourceModifiedAt: opts.sourceModifiedAt,
    versionGroupId: null,
    versionSeq: null,
    supersedesDocumentId: null,
    validFrom: null,
    validTo: opts.validTo,
    sensitivityClassId: null,
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt: opts.paraCreatedAt,
    updatedAt: opts.paraCreatedAt,
    deletedAt: null,
  });
  b.paragraphs.set(paraId, {
    id: paraId,
    tenantId: TENANT,
    documentId: docId,
    paragraphIndex: 0,
    page: 1,
    text: opts.text,
    structure: {},
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt: opts.paraCreatedAt,
    updatedAt: opts.paraCreatedAt,
    deletedAt: null,
  });
  return { docId, paraId };
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('ContextRetriever — supersession demote (P3a)', () => {
  it('a current version outranks a superseded one — but the superseded stays present', async () => {
    const b = emptyBacking();
    const cur = docPara(b, {
      sourceModifiedAt: null,
      validTo: null, // current/live
      paraCreatedAt: ago(1),
      text: 'current version text',
    });
    const sup = docPara(b, {
      sourceModifiedAt: null,
      validTo: ago(1), // superseded
      paraCreatedAt: ago(1),
      text: 'superseded version text',
    });
    // Superseded is FIRST in the vector order → without demotion it would rank first.
    const { store } = fakeStore(b, { vectorHitParagraphIds: [sup.paraId, cur.paraId] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, { question: 'what is the policy?' });
    expect(ctx.kind).toBe('context');
    if (ctx.kind !== 'context') return;
    // Both present (demote, never drop) …
    expect(ctx.sources).toHaveLength(2);
    const ids = ctx.sources.map((s) => s.paragraph.id);
    expect(ids).toContain(cur.paraId);
    expect(ids).toContain(sup.paraId);
    // … and the CURRENT version ranks above the superseded one.
    expect(ctx.sources[0]?.paragraph.id).toBe(cur.paraId);
  });

  it('demotion off (factor 1) leaves the superseded version in its original rank', async () => {
    const b = emptyBacking();
    const cur = docPara(b, {
      sourceModifiedAt: null,
      validTo: null,
      paraCreatedAt: ago(1),
      text: 'current',
    });
    const sup = docPara(b, {
      sourceModifiedAt: null,
      validTo: ago(1),
      paraCreatedAt: ago(1),
      text: 'superseded',
    });
    const { store } = fakeStore(b, { vectorHitParagraphIds: [sup.paraId, cur.paraId] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'what is the policy?',
      options: { supersededDemotionFactor: 1 },
    });
    if (ctx.kind !== 'context') return;
    // With demotion disabled, the vector order is preserved (superseded first).
    expect(ctx.sources[0]?.paragraph.id).toBe(sup.paraId);
  });
});

describe('ContextRetriever — F40 recency by sourceModifiedAt (P3a)', () => {
  it('ranks by the document real-world date (sourceModifiedAt), not paragraph ingestion time', async () => {
    const b = emptyBacking();
    // docA: ingested long ago (old paragraph createdAt) but its real-world date is RECENT.
    const a = docPara(b, {
      sourceModifiedAt: ago(1),
      validTo: null,
      paraCreatedAt: ago(400),
      text: 'doc A — recently dated, ingested long ago',
    });
    // docB: ingested recently but its real-world date is OLD.
    const bb = docPara(b, {
      sourceModifiedAt: ago(400),
      validTo: null,
      paraCreatedAt: ago(1),
      text: 'doc B — old date, recently ingested',
    });
    // B is FIRST in vector order. If recency keyed on paragraph createdAt, B (recent
    // createdAt) would stay first; keyed on sourceModifiedAt, A (recent date) wins.
    const { store } = fakeStore(b, { vectorHitParagraphIds: [bb.paraId, a.paraId] });
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: fakeEmbedding(),
    });

    const ctx = await retriever.retrieveContext(READ_CTX, {
      question: 'what is the policy?',
      options: { recencyHalfLifeDays: 30 },
    });
    if (ctx.kind !== 'context') return;
    expect(ctx.sources[0]?.paragraph.id).toBe(a.paraId); // sourceModifiedAt drives it
  });
});

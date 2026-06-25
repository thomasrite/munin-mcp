// Per-read audit decorator (F10/F26) — wraps any GraphStore and records ONE
// content-free audit_events row per READ CALL (not per row returned).
//
// PERMISSION-NEUTRALITY IS THE INVARIANT: every method passes ctx and arguments
// through to the inner store byte-untouched and returns the inner result
// unchanged. The decorator filters nothing, widens nothing, and never re-orders
// or copies results — proven by the pass-through fidelity suite
// (audited-graph-store.test.ts) and the decorated no-leak smoke
// (read-audit.int.test.ts). The P0 permission suite continues to run against
// the RAW store, untouched.
//
// REGULAR READS ONLY. Bypass reads are deliberately NOT recorded here: every
// bypass read is already tamper-evidently logged in `internal_bypass_log` (in
// the same transaction as the read, with call site + reason) — double-logging
// would split the bypass trail across two tables and let a partial reader
// believe one of them is complete. The two trails are complementary:
// audit_events = who exercised their REGULAR permissions; internal_bypass_log =
// which SYSTEM operations crossed the access filter. (One precise carve-out:
// findRecentQueryEvents / countQueryEvents are content-free telemetry reads
// with no access-tag filter to bypass, so the inner store deliberately skips
// bypass logging for them — under a BYPASS context those two land in neither
// trail. Under a regular context this decorator records them like any read.)
//
// What is recorded per read: action 'read.<method>', the method's natural
// single target where one exists (else null), the caller's access tags, and
// details = { resultCount } — NOTHING ELSE. Never content, never query text,
// never hashes/external ids/vectors, never paragraph or entity values.
//
// Recording is a synchronous in-memory buffer append (see read-audit.ts) —
// fail-open with a visible drop counter. An audit write can never block, slow,
// or fail the read it describes.
//
// Writes delegate verbatim — mutations already write their own in-transaction
// audit rows (P6a). withTransaction wraps the transactional store so reads
// inside a transaction cannot escape auditing; their events join the same
// shared buffer (they flush independently of the transaction — an audit row
// for a read inside a rolled-back transaction is still honest: the read
// happened).

import type { GraphStore } from './graph-store';
import type { ReadAuditSink } from './read-audit';
import type {
  AuditEventInput,
  AuditEventRecord,
  CitationEventInput,
  Document,
  DocumentDuplicateLink,
  DocumentFingerprint,
  DocumentId,
  DocumentPage,
  DocumentQuery,
  Edge,
  EdgeId,
  EdgePage,
  EdgePatch,
  EdgeQuery,
  Embedding,
  Entity,
  EntityId,
  EntityPage,
  EntityPatch,
  EntityQuery,
  ExtractorVersion,
  ExtractorVersionNaturalKey,
  GraphStats,
  HardDeleteReceipt,
  KeywordSearchQuery,
  KeywordSearchResult,
  LlmCallRecord,
  LlmEgressSummary,
  NeighbourQuery,
  NewDocument,
  NewDocumentDuplicate,
  NewEdge,
  NewEmbedding,
  NewEntity,
  NewExtractorVersion,
  NewLlmCall,
  NewParagraph,
  NewQueryEvent,
  NewReviewItem,
  Paragraph,
  ParagraphId,
  QueryEvent,
  ReadContext,
  ReviewDecision,
  ReviewItem,
  ReviewItemId,
  ReviewQueueQuery,
  VectorSearchQuery,
  VectorSearchResult,
  WriteContext,
} from './types';

export class AuditedGraphStore implements GraphStore {
  private readonly inner: GraphStore;
  private readonly sink: ReadAuditSink;

  constructor(inner: GraphStore, sink: ReadAuditSink) {
    this.inner = inner;
    this.sink = sink;
  }

  // One buffered, content-free event per regular read call. Bypass reads are
  // already logged in internal_bypass_log — see the header.
  private record(
    ctx: ReadContext,
    method: string,
    targetKind: string,
    targetId: string | null,
    resultCount: number,
  ): void {
    if (ctx.kind !== 'regular') return;
    this.sink.record({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      action: `read.${method}`,
      targetKind,
      targetId,
      // Snapshot, not the caller's reference: the event can sit buffered for
      // seconds, and an audit row must record the tags AS USED at read time —
      // a post-read mutation of the caller's array must not rewrite history.
      accessTagsUsed: [...ctx.accessTags],
      resultCount,
      occurredAt: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // Reads — delegate untouched, then record.
  // -------------------------------------------------------------------------

  async getEntity(ctx: ReadContext, id: EntityId): Promise<Entity | null> {
    const result = await this.inner.getEntity(ctx, id);
    this.record(ctx, 'getEntity', 'entity', id, result ? 1 : 0);
    return result;
  }

  async getEntitiesByIds(ctx: ReadContext, ids: readonly EntityId[]): Promise<readonly Entity[]> {
    const result = await this.inner.getEntitiesByIds(ctx, ids);
    this.record(ctx, 'getEntitiesByIds', 'entity', null, result.length);
    return result;
  }

  async findParagraphsPendingExtraction(
    ctx: ReadContext,
    opts: { readonly schemaHash: string },
  ): Promise<readonly Paragraph[]> {
    const result = await this.inner.findParagraphsPendingExtraction(ctx, opts);
    this.record(ctx, 'findParagraphsPendingExtraction', 'paragraph', null, result.length);
    return result;
  }

  async findEntities(ctx: ReadContext, query: EntityQuery): Promise<EntityPage> {
    const result = await this.inner.findEntities(ctx, query);
    this.record(ctx, 'findEntities', 'entity', null, result.items.length);
    return result;
  }

  async findEntitiesByParagraphIds(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<readonly Entity[]> {
    const result = await this.inner.findEntitiesByParagraphIds(ctx, paragraphIds);
    this.record(ctx, 'findEntitiesByParagraphIds', 'entity', null, result.length);
    return result;
  }

  async getEdge(ctx: ReadContext, id: EdgeId): Promise<Edge | null> {
    const result = await this.inner.getEdge(ctx, id);
    this.record(ctx, 'getEdge', 'edge', id, result ? 1 : 0);
    return result;
  }

  async findEdges(ctx: ReadContext, query: EdgeQuery): Promise<EdgePage> {
    const result = await this.inner.findEdges(ctx, query);
    this.record(ctx, 'findEdges', 'edge', null, result.items.length);
    return result;
  }

  async getNeighbours(
    ctx: ReadContext,
    entityId: EntityId,
    query: NeighbourQuery,
  ): Promise<{ entities: readonly Entity[]; edges: readonly Edge[] }> {
    const result = await this.inner.getNeighbours(ctx, entityId, query);
    this.record(
      ctx,
      'getNeighbours',
      'entity',
      entityId,
      result.entities.length + result.edges.length,
    );
    return result;
  }

  async getGraphStats(ctx: ReadContext): Promise<GraphStats> {
    const result = await this.inner.getGraphStats(ctx);
    this.record(ctx, 'getGraphStats', 'graph', null, result.entitiesByType.length);
    return result;
  }

  async getDocument(ctx: ReadContext, id: DocumentId): Promise<Document | null> {
    const result = await this.inner.getDocument(ctx, id);
    this.record(ctx, 'getDocument', 'document', id, result ? 1 : 0);
    return result;
  }

  async getDocumentsByIds(
    ctx: ReadContext,
    ids: readonly DocumentId[],
  ): Promise<readonly Document[]> {
    const result = await this.inner.getDocumentsByIds(ctx, ids);
    this.record(ctx, 'getDocumentsByIds', 'document', null, result.length);
    return result;
  }

  async getParagraph(ctx: ReadContext, id: ParagraphId): Promise<Paragraph | null> {
    const result = await this.inner.getParagraph(ctx, id);
    this.record(ctx, 'getParagraph', 'paragraph', id, result ? 1 : 0);
    return result;
  }

  async getParagraphsByIds(
    ctx: ReadContext,
    ids: readonly ParagraphId[],
  ): Promise<readonly Paragraph[]> {
    const result = await this.inner.getParagraphsByIds(ctx, ids);
    this.record(ctx, 'getParagraphsByIds', 'paragraph', null, result.length);
    return result;
  }

  async findParagraphsByDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly Paragraph[]> {
    const result = await this.inner.findParagraphsByDocument(ctx, documentId);
    this.record(ctx, 'findParagraphsByDocument', 'document', documentId, result.length);
    return result;
  }

  // No targetId: the sha256 argument is content-derived and is never recorded.
  async findDocumentByHash(ctx: ReadContext, sha256: string): Promise<Document | null> {
    const result = await this.inner.findDocumentByHash(ctx, sha256);
    this.record(ctx, 'findDocumentByHash', 'document', null, result ? 1 : 0);
    return result;
  }

  // No targetId: the external id is a connector-side identifier, not ours.
  async findLatestLiveDocumentByExternalId(
    ctx: ReadContext,
    opts: { readonly connectorPackage: string; readonly externalId: string },
  ): Promise<Document | null> {
    const result = await this.inner.findLatestLiveDocumentByExternalId(ctx, opts);
    this.record(ctx, 'findLatestLiveDocumentByExternalId', 'document', null, result ? 1 : 0);
    return result;
  }

  async findDocumentFingerprints(
    ctx: ReadContext,
    opts: { readonly limit: number },
  ): Promise<readonly DocumentFingerprint[]> {
    const result = await this.inner.findDocumentFingerprints(ctx, opts);
    this.record(ctx, 'findDocumentFingerprints', 'document', null, result.length);
    return result;
  }

  async findDuplicatesForDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly DocumentDuplicateLink[]> {
    const result = await this.inner.findDuplicatesForDocument(ctx, documentId);
    this.record(ctx, 'findDuplicatesForDocument', 'document', documentId, result.length);
    return result;
  }

  async findDocuments(ctx: ReadContext, query: DocumentQuery): Promise<DocumentPage> {
    const result = await this.inner.findDocuments(ctx, query);
    this.record(ctx, 'findDocuments', 'document', null, result.items.length);
    return result;
  }

  async findRecentQueryEvents(
    ctx: ReadContext,
    query: { readonly limit?: number },
  ): Promise<readonly QueryEvent[]> {
    const result = await this.inner.findRecentQueryEvents(ctx, query);
    this.record(ctx, 'findRecentQueryEvents', 'query_event', null, result.length);
    return result;
  }

  async countQueryEvents(
    ctx: ReadContext,
    query: { readonly since: Date; readonly byActor: boolean },
  ): Promise<number> {
    const result = await this.inner.countQueryEvents(ctx, query);
    this.record(ctx, 'countQueryEvents', 'query_event', null, result);
    return result;
  }

  async listAuditEvents(
    ctx: ReadContext,
    query?: { readonly since?: Date; readonly limit?: number },
  ): Promise<readonly AuditEventRecord[]> {
    const result = await this.inner.listAuditEvents(ctx, query);
    this.record(ctx, 'listAuditEvents', 'audit_event', null, result.length);
    return result;
  }

  async listLlmCalls(
    ctx: ReadContext,
    query?: {
      readonly since?: Date;
      readonly limit?: number;
      readonly purpose?: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
    },
  ): Promise<readonly LlmCallRecord[]> {
    const result = await this.inner.listLlmCalls(ctx, query);
    this.record(ctx, 'listLlmCalls', 'llm_call', null, result.length);
    return result;
  }

  async summariseLlmCalls(
    ctx: ReadContext,
    query?: { readonly since?: Date },
  ): Promise<LlmEgressSummary> {
    const result = await this.inner.summariseLlmCalls(ctx, query);
    this.record(ctx, 'summariseLlmCalls', 'llm_call', null, result.byRegion.length);
    return result;
  }

  async findExtractorVersion(
    ctx: ReadContext,
    key: ExtractorVersionNaturalKey,
  ): Promise<ExtractorVersion | null> {
    const result = await this.inner.findExtractorVersion(ctx, key);
    this.record(ctx, 'findExtractorVersion', 'extractor_version', null, result ? 1 : 0);
    return result;
  }

  // No detail beyond the hit count — the query vector never leaves the call.
  async searchByVector(
    ctx: ReadContext,
    query: VectorSearchQuery,
  ): Promise<readonly VectorSearchResult[]> {
    const result = await this.inner.searchByVector(ctx, query);
    this.record(ctx, 'searchByVector', 'embedding', null, result.length);
    return result;
  }

  async getEmbeddingsByTargets(
    ctx: ReadContext,
    query: {
      readonly targetKind: 'paragraph' | 'entity';
      readonly targetIds: readonly string[];
      readonly modelId: string;
    },
  ): Promise<readonly Embedding[]> {
    const result = await this.inner.getEmbeddingsByTargets(ctx, query);
    this.record(ctx, 'getEmbeddingsByTargets', 'embedding', null, result.length);
    return result;
  }

  // No detail beyond the hit count — the query TEXT never leaves the call.
  async searchByKeyword(
    ctx: ReadContext,
    query: KeywordSearchQuery,
  ): Promise<readonly KeywordSearchResult[]> {
    const result = await this.inner.searchByKeyword(ctx, query);
    this.record(ctx, 'searchByKeyword', 'paragraph', null, result.length);
    return result;
  }

  async countCitationsByParagraph(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<ReadonlyMap<ParagraphId, number>> {
    const result = await this.inner.countCitationsByParagraph(ctx, paragraphIds);
    this.record(ctx, 'countCitationsByParagraph', 'paragraph', null, result.size);
    return result;
  }

  async countCitationsByDocument(
    ctx: ReadContext,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, number>> {
    const result = await this.inner.countCitationsByDocument(ctx, documentIds);
    this.record(ctx, 'countCitationsByDocument', 'document', null, result.size);
    return result;
  }

  async getReviewItem(ctx: ReadContext, id: ReviewItemId): Promise<ReviewItem | null> {
    const result = await this.inner.getReviewItem(ctx, id);
    this.record(ctx, 'getReviewItem', 'review_item', id, result ? 1 : 0);
    return result;
  }

  async findPendingReviewItems(
    ctx: ReadContext,
    query?: ReviewQueueQuery,
  ): Promise<readonly ReviewItem[]> {
    const result = await this.inner.findPendingReviewItems(ctx, query);
    this.record(ctx, 'findPendingReviewItems', 'review_item', null, result.length);
    return result;
  }

  // -------------------------------------------------------------------------
  // Writes — verbatim delegation. Mutations audit themselves in-transaction
  // (P6a); adding read-audit rows here would double-log.
  // -------------------------------------------------------------------------

  insertEntity(ctx: WriteContext, params: NewEntity): Promise<Entity> {
    return this.inner.insertEntity(ctx, params);
  }

  insertEntitiesBulk(ctx: WriteContext, params: readonly NewEntity[]): Promise<readonly Entity[]> {
    return this.inner.insertEntitiesBulk(ctx, params);
  }

  updateEntity(ctx: WriteContext, id: EntityId, patch: EntityPatch): Promise<Entity> {
    return this.inner.updateEntity(ctx, id, patch);
  }

  softDeleteEntity(ctx: WriteContext, id: EntityId): Promise<void> {
    return this.inner.softDeleteEntity(ctx, id);
  }

  softDeleteExtractionsBySchema(
    ctx: WriteContext,
    opts: { readonly keepSchemaHash: string },
  ): Promise<{ readonly entitiesDeleted: number; readonly edgesDeleted: number }> {
    return this.inner.softDeleteExtractionsBySchema(ctx, opts);
  }

  insertEdge(ctx: WriteContext, params: NewEdge): Promise<Edge> {
    return this.inner.insertEdge(ctx, params);
  }

  insertEdgesBulk(ctx: WriteContext, params: readonly NewEdge[]): Promise<readonly Edge[]> {
    return this.inner.insertEdgesBulk(ctx, params);
  }

  updateEdge(ctx: WriteContext, id: EdgeId, patch: EdgePatch): Promise<Edge> {
    return this.inner.updateEdge(ctx, id, patch);
  }

  softDeleteEdge(ctx: WriteContext, id: EdgeId): Promise<void> {
    return this.inner.softDeleteEdge(ctx, id);
  }

  insertDocument(ctx: WriteContext, params: NewDocument): Promise<Document> {
    return this.inner.insertDocument(ctx, params);
  }

  insertParagraphsBulk(
    ctx: WriteContext,
    params: readonly NewParagraph[],
  ): Promise<readonly Paragraph[]> {
    return this.inner.insertParagraphsBulk(ctx, params);
  }

  softDeleteDocument(ctx: WriteContext, id: DocumentId): Promise<void> {
    return this.inner.softDeleteDocument(ctx, id);
  }

  supersedeDocument(
    ctx: WriteContext,
    id: DocumentId,
    opts: { readonly validTo: Date },
  ): Promise<void> {
    return this.inner.supersedeDocument(ctx, id, opts);
  }

  recordDocumentDuplicate(ctx: WriteContext, params: NewDocumentDuplicate): Promise<void> {
    return this.inner.recordDocumentDuplicate(ctx, params);
  }

  hardDeleteDocument(ctx: WriteContext, id: DocumentId): Promise<HardDeleteReceipt> {
    return this.inner.hardDeleteDocument(ctx, id);
  }

  recordIncompleteErasure(
    ctx: WriteContext,
    params: { readonly documentId: DocumentId; readonly reason: string },
  ): Promise<void> {
    return this.inner.recordIncompleteErasure(ctx, params);
  }

  upsertExtractorVersion(
    ctx: WriteContext,
    params: NewExtractorVersion,
  ): Promise<ExtractorVersion> {
    return this.inner.upsertExtractorVersion(ctx, params);
  }

  upsertEmbedding(ctx: WriteContext, params: NewEmbedding): Promise<Embedding> {
    return this.inner.upsertEmbedding(ctx, params);
  }

  insertLlmCall(ctx: WriteContext, params: NewLlmCall): Promise<void> {
    return this.inner.insertLlmCall(ctx, params);
  }

  insertQueryEvent(ctx: WriteContext, params: NewQueryEvent): Promise<void> {
    return this.inner.insertQueryEvent(ctx, params);
  }

  insertCitationEvents(ctx: WriteContext, events: readonly CitationEventInput[]): Promise<void> {
    return this.inner.insertCitationEvents(ctx, events);
  }

  recordAuditEvent(ctx: WriteContext, params: AuditEventInput): Promise<void> {
    return this.inner.recordAuditEvent(ctx, params);
  }

  enqueueReviewItem(ctx: WriteContext, params: NewReviewItem): Promise<ReviewItem> {
    return this.inner.enqueueReviewItem(ctx, params);
  }

  resolveReviewItem(
    ctx: WriteContext,
    id: ReviewItemId,
    decision: ReviewDecision,
  ): Promise<ReviewItem> {
    return this.inner.resolveReviewItem(ctx, id, decision);
  }

  deletePendingReviewItemsByTargets(
    ctx: WriteContext,
    targetKind: string,
    targetIds: readonly string[],
  ): Promise<number> {
    return this.inner.deletePendingReviewItemsByTargets(ctx, targetKind, targetIds);
  }

  scrubResolvedReviewItems(ctx: WriteContext, cutoff: Date): Promise<number> {
    return this.inner.scrubResolvedReviewItems(ctx, cutoff);
  }

  // The transactional store is wrapped too — a read inside a transaction must
  // not escape auditing. Events share this decorator's sink (and flush
  // independently of the transaction; see the header).
  withTransaction<T>(ctx: WriteContext, fn: (tx: GraphStore) => Promise<T>): Promise<T> {
    return this.inner.withTransaction(ctx, (tx) => fn(new AuditedGraphStore(tx, this.sink)));
  }
}

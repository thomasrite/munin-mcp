// Public interfaces for the engine's data-access layer.
//
// Two interfaces, one implementation. Splitting `GraphStoreReader` from
// `GraphStoreWriter` makes the "reads require accessTags" rule structural:
// you cannot accidentally call a write method with a `ReadContext` or a
// read method with a `WriteContext`. Modules that only need one half can
// depend on the narrow interface.

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

export interface GraphStoreReader {
  // Entities ----------------------------------------------------------------
  getEntity(ctx: ReadContext, id: EntityId): Promise<Entity | null>;
  getEntitiesByIds(ctx: ReadContext, ids: readonly EntityId[]): Promise<readonly Entity[]>;
  // Paragraphs that have no live entity whose extractor_version carries the
  // given schemaHash. The extraction CLI's "what still needs extracting under
  // the current schema?" query. Tenant-scoped, soft-delete excluded, access-tag
  // filtered like every other read. No cross-document ordering is guaranteed —
  // callers use the ids, not the order.
  findParagraphsPendingExtraction(
    ctx: ReadContext,
    opts: { readonly schemaHash: string },
  ): Promise<readonly Paragraph[]>;
  findEntities(ctx: ReadContext, query: EntityQuery): Promise<EntityPage>;
  // Entities whose document_extract provenance points at any of the given
  // paragraphs. The query layer's graph-expansion entry point: retrieved
  // paragraphs → the entities extracted from them. Tenant-scoped, soft-delete
  // excluded, access-tag filtered like every other read.
  findEntitiesByParagraphIds(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<readonly Entity[]>;

  // Edges -------------------------------------------------------------------
  getEdge(ctx: ReadContext, id: EdgeId): Promise<Edge | null>;
  findEdges(ctx: ReadContext, query: EdgeQuery): Promise<EdgePage>;
  getNeighbours(
    ctx: ReadContext,
    entityId: EntityId,
    query: NeighbourQuery,
  ): Promise<{ entities: readonly Entity[]; edges: readonly Edge[] }>;

  // Aggregate graph stats ----------------------------------------------------
  // Live entity counts grouped by type + a live edge total, for an overview
  // surface — computed in ONE grouped query per table (GROUP BY type), never N
  // findEntities calls. PERMISSION-CORRECT: applies the SAME tenant + soft-delete
  // + access-tag filter as findEntities/findEdges, so the numbers count ONLY rows
  // the caller may see; an empty caller tag set sees nothing (every count zero,
  // fail-closed) and a type the caller cannot see never appears.
  getGraphStats(ctx: ReadContext): Promise<GraphStats>;

  // Documents and paragraphs ------------------------------------------------
  getDocument(ctx: ReadContext, id: DocumentId): Promise<Document | null>;
  // Batched companion to getDocument: empty-list short-circuit, access-tag
  // filtered, invisible/cross-tenant ids silently dropped. Order not preserved.
  getDocumentsByIds(ctx: ReadContext, ids: readonly DocumentId[]): Promise<readonly Document[]>;
  getParagraph(ctx: ReadContext, id: ParagraphId): Promise<Paragraph | null>;
  // Batched companion to getParagraph: empty-list short-circuit, access-tag
  // filtered, invisible/cross-tenant ids silently dropped. Order not preserved.
  getParagraphsByIds(ctx: ReadContext, ids: readonly ParagraphId[]): Promise<readonly Paragraph[]>;
  findParagraphsByDocument(ctx: ReadContext, documentId: DocumentId): Promise<readonly Paragraph[]>;
  // Used by ingestion's idempotency check. System operation — bypass
  // context expected.
  findDocumentByHash(ctx: ReadContext, sha256: string): Promise<Document | null>;
  // The current/live version of a connector document (P3a). Returns the row with
  // the matching (connector_package, external_id) and no validTo, or null. Used
  // by re-ingest to find the prior version to supersede (system op → bypass).
  // Access-tag filtered like every read (so a regular caller only finds what
  // they may see). Soft-delete excluded.
  findLatestLiveDocumentByExternalId(
    ctx: ReadContext,
    opts: { readonly connectorPackage: string; readonly externalId: string },
  ): Promise<Document | null>;
  // The near-duplicate fingerprint scan (P3a). Returns (id, simhash) for the
  // tenant's documents that carry a fingerprint, newest first, capped at
  // `opts.limit`. The caller compares fingerprints by Hamming distance. A
  // BOUNDED candidate scan — LSH banding is deferred until corpus volume
  // justifies it. Access-tag filtered like every read (under bypass it sees the
  // full tenant corpus, which is correct: detection is a system operation; the
  // resulting links are only EXPOSED via findDuplicatesForDocument, which is
  // access-gated on both endpoints).
  findDocumentFingerprints(
    ctx: ReadContext,
    opts: { readonly limit: number },
  ): Promise<readonly DocumentFingerprint[]>;
  // The duplicate links touching `documentId` (P3a). Access-gated on BOTH
  // endpoints: a link is returned only when the caller can see the queried
  // document AND its counterpart — so a near/semantic link can never reveal the
  // existence of a document the caller is not cleared to see. Tenant-scoped,
  // soft-delete excluded (via the endpoint documents). Empty for an invisible
  // queried document.
  findDuplicatesForDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly DocumentDuplicateLink[]>;
  // Paginated, access-tag-filtered document list, newest first (D2). Powers the
  // dashboard's recent-ingestions panel and document browser. Permission-correct
  // by construction (same readFilters as every content read).
  findDocuments(ctx: ReadContext, query: DocumentQuery): Promise<DocumentPage>;
  // The caller's own recent query telemetry, newest first (D2). Tenant + actor
  // scoped (a user sees only their own activity); telemetry carries no content,
  // so this is NOT access-tag-gated. Powers the dashboard recent-activity panel.
  findRecentQueryEvents(
    ctx: ReadContext,
    query: { readonly limit?: number },
  ): Promise<readonly QueryEvent[]>;
  // Count of query_events at/after `since`, tenant-scoped; `byActor` narrows to
  // ctx.actor (else tenant-wide). Powers the web's daily spend guard (a cost
  // throttle, NOT a billing entitlement). Like findRecentQueryEvents this is
  // telemetry: no content, so NOT access-tag-gated. The count is approximate by
  // construction — query_events are written best-effort by the pipeline, so a
  // dropped telemetry write under-counts (never over-counts), the safe
  // direction for a guard checked before spend.
  countQueryEvents(
    ctx: ReadContext,
    query: { readonly since: Date; readonly byActor: boolean },
  ): Promise<number>;

  // Accountability + cost telemetry reads ------------------------------------
  // These three read the content-free accountability/telemetry tables
  // (audit_events, llm_calls). Those tables carry NO access_tags column — they
  // are not content, they record WHO did WHAT and WHERE AI calls went — so, like
  // findRecentQueryEvents / countQueryEvents, the reads are TENANT-SCOPED but NOT
  // access-tag-gated (there is no access filter to apply, and an access/cost
  // surface that hid rows by clearance would defeat its own purpose). Authorising
  // WHO may view these surfaces (admin / DPO) is the layer-above's job, exactly
  // like the steward-capability check above the review queue. None of them use
  // internalBypass; they take a normal ReadContext and filter by ctx.tenantId.

  // The tenant's audit trail, newest first (the access-audit / data-activity
  // page). Rows are content-free (AuditEventRecord; the free-form details bag is
  // not projected). `since` lower-bounds occurredAt (inclusive); `limit` caps the
  // page. TENANT-SCOPED, NOT access-tag-gated — by design: an access-audit page
  // exists to show ALL access in the tenant, so it returns every actor's rows
  // including the `targetId` of records the VIEWER's own tags could not read.
  // That cross-clearance existence visibility is the point of an audit log, not a
  // leak — but it means this surface MUST be gated to an admin/DPO capability
  // ABOVE the engine (like the steward check above the review queue); it is not
  // for a low-clearance / chat-only member.
  listAuditEvents(
    ctx: ReadContext,
    query?: { readonly since?: Date; readonly limit?: number },
  ): Promise<readonly AuditEventRecord[]>;

  // The tenant's individual AI-call rows, newest first (the receipts activity
  // feed). Content-free (tokens/cost/region/model, never prompt or completion).
  // `since` lower-bounds occurredAt (inclusive); `purpose` narrows to one call
  // kind; `limit` caps the page.
  listLlmCalls(
    ctx: ReadContext,
    query?: {
      readonly since?: Date;
      readonly limit?: number;
      readonly purpose?: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
    },
  ): Promise<readonly LlmCallRecord[]>;

  // The tenant's region/egress rollup: per-region call counts + summed cost, plus
  // on-device-vs-cloud-vs-stub totals (the receipts headline). TENANT-SCOPED —
  // deliberately NOT the operator-facing, cross-tenant generateResidencyReport.
  // `since` lower-bounds occurredAt (inclusive).
  summariseLlmCalls(ctx: ReadContext, query?: { readonly since?: Date }): Promise<LlmEgressSummary>;

  // Extractor versions ------------------------------------------------------
  findExtractorVersion(
    ctx: ReadContext,
    key: ExtractorVersionNaturalKey,
  ): Promise<ExtractorVersion | null>;

  // Vector search -----------------------------------------------------------
  // Returns the top-k embeddings nearest to query.queryVector, filtered by
  // tenant scoping, soft-delete exclusion (via the underlying paragraph),
  // and access-tag intersection on the embedding row itself.
  searchByVector(
    ctx: ReadContext,
    query: VectorSearchQuery,
  ): Promise<readonly VectorSearchResult[]>;

  // Fetch the embedding rows for a set of targets under one model (P3a). Used by
  // the semantic-duplicate detector to read a document's paragraph vectors so it
  // can compute a centroid. Access-tag filtered like every read (under bypass —
  // the detector's system context — it sees the full tenant set). Empty input
  // returns []. Order not preserved.
  getEmbeddingsByTargets(
    ctx: ReadContext,
    query: {
      readonly targetKind: 'paragraph' | 'entity';
      readonly targetIds: readonly string[];
      readonly modelId: string;
    },
  ): Promise<readonly Embedding[]>;

  // Keyword (lexical / full-text) search -------------------------------------
  // Returns the top-k paragraphs whose text matches the query terms, ranked by
  // lexical relevance (Postgres full-text search). Filtered by the SAME tenant +
  // access-tag + soft-delete read filter as every other read — there is no
  // separate permission path. The complement to searchByVector for exact terms,
  // proper nouns, codes, and spelling variants. An empty query returns [].
  searchByKeyword(
    ctx: ReadContext,
    query: KeywordSearchQuery,
  ): Promise<readonly KeywordSearchResult[]>;

  // Citation-frequency signal (the learning-loop seed) ------------------------
  // For the given candidate paragraph ids, returns how many times each was cited
  // (COUNT over citation_events) within the caller's tenant. PERMISSION-CORRECT:
  // joins to paragraphs and applies the SAME access filter as every read, so a
  // count is returned ONLY for a paragraph the caller can already see — passing
  // an id the caller cannot see yields no entry (never leaks usage/existence).
  // Ids not present in the map were cited zero times (or are not visible). An
  // empty input returns an empty map. The intended consumer is a soft per-tenant
  // ranking boost over the already-retrieved candidate set.
  countCitationsByParagraph(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<ReadonlyMap<ParagraphId, number>>;

  // Per-DOCUMENT citation rollup (the library "cited N×" signal) — the document-
  // grained companion to countCitationsByParagraph. For the given candidate
  // document ids, returns how many times each was cited (COUNT over
  // citation_events.document_id) within the caller's tenant. PERMISSION-CORRECT:
  // joins to documents and applies the SAME access filter as every read, so a
  // count is returned ONLY for a document the caller can already see — passing an
  // id the caller cannot see yields no entry (never leaks usage/existence). Ids
  // absent from the map were cited zero times (or are not visible). Empty input
  // returns an empty map.
  countCitationsByDocument(
    ctx: ReadContext,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, number>>;

  // Review queue (P6a) -------------------------------------------------------
  // A single review item by id, ACCESS-GATED like every read: returned only when
  // its access_tags intersect the caller's (so a steward can act only on an item
  // whose target they are permitted to see). Tenant-scoped. null if absent,
  // cross-tenant, or invisible to the caller. Any status (the caller checks it).
  getReviewItem(ctx: ReadContext, id: ReviewItemId): Promise<ReviewItem | null>;
  // The PENDING items the caller is permitted to see, oldest first. THE
  // governance read: access-tag filtered by the SAME array-overlap as every
  // content read, so a steward sees only items whose target they may see — never
  // a queued correction for a record outside their clearance. An empty caller
  // tag set sees nothing (fail-closed).
  findPendingReviewItems(
    ctx: ReadContext,
    query?: ReviewQueueQuery,
  ): Promise<readonly ReviewItem[]>;
}

export interface GraphStoreWriter {
  // Entities ----------------------------------------------------------------
  insertEntity(ctx: WriteContext, params: NewEntity): Promise<Entity>;
  insertEntitiesBulk(ctx: WriteContext, params: readonly NewEntity[]): Promise<readonly Entity[]>;
  updateEntity(ctx: WriteContext, id: EntityId, patch: EntityPatch): Promise<Entity>;
  // Soft-delete cascades to incident edges in the same transaction.
  softDeleteEntity(ctx: WriteContext, id: EntityId): Promise<void>;
  // Soft-delete every live entity (and its incident edges) and every live edge
  // whose extractor_version carries a schema hash OTHER than keepSchemaHash —
  // i.e. drop extractions produced under a superseded schema. Tenant-scoped;
  // runs in one transaction; reuses the entity→incident-edge cascade. The
  // extraction CLI's `--re-extract` uses this to clear stale-schema output
  // before re-enqueuing. Returns the soft-deleted counts.
  softDeleteExtractionsBySchema(
    ctx: WriteContext,
    opts: { readonly keepSchemaHash: string },
  ): Promise<{ readonly entitiesDeleted: number; readonly edgesDeleted: number }>;

  // Edges -------------------------------------------------------------------
  insertEdge(ctx: WriteContext, params: NewEdge): Promise<Edge>;
  insertEdgesBulk(ctx: WriteContext, params: readonly NewEdge[]): Promise<readonly Edge[]>;
  updateEdge(ctx: WriteContext, id: EdgeId, patch: EdgePatch): Promise<Edge>;
  softDeleteEdge(ctx: WriteContext, id: EdgeId): Promise<void>;

  // Documents and paragraphs ------------------------------------------------
  insertDocument(ctx: WriteContext, params: NewDocument): Promise<Document>;
  insertParagraphsBulk(
    ctx: WriteContext,
    params: readonly NewParagraph[],
  ): Promise<readonly Paragraph[]>;
  softDeleteDocument(ctx: WriteContext, id: DocumentId): Promise<void>;
  // Mark a prior document version superseded by stamping `valid_to` (P3a). The
  // row stays LIVE and retrievable — query-time ranking demotes it, it is never
  // dropped. Idempotent: only acts on a not-yet-superseded, non-deleted row.
  supersedeDocument(
    ctx: WriteContext,
    id: DocumentId,
    opts: { readonly validTo: Date },
  ): Promise<void>;
  // Record a near/semantic duplicate LINK (P3a). NEVER a merge or a skip: both
  // documents stay fully ingested. Idempotent on the (tenant, document,
  // duplicate_of, method) natural key — re-running detection records once.
  recordDocumentDuplicate(ctx: WriteContext, params: NewDocumentDuplicate): Promise<void>;

  // Right-to-erasure (P6b): HARD-DELETE a document and everything derived from it
  // in ONE transaction, leaving ZERO orphans — paragraphs, embeddings (both the
  // paragraph and entity vectors; polymorphic, no FK), extracted entities + edges
  // (their source_document_id FK is ON DELETE SET NULL, so they must be deleted
  // EXPLICITLY or they survive content-intact), citation_events and duplicate
  // links, and (F54) any PENDING review items targeting the erased entities/edges
  // (their proposed_change may carry document-derived values; resolved items stay
  // as the decision trail). Writes ONE in-transaction audit_events row (action
  // 'hard_delete_document', content-free counts) AND one internal_bypass_log row:
  // erasure deliberately crosses access tags (it must remove the doc's rows
  // regardless of how they're tagged) — that access-filter bypass is recorded,
  // tenant isolation is NEVER dropped. Operates regardless of soft-delete state.
  // Returns a content-free receipt (counts + the blob URI to erase next); does
  // NOT touch blob storage (the orchestrator deletes + verifies the blob AFTER
  // this transaction commits — honest erasure). Throws NotFoundError for an
  // unknown document (in this tenant).
  hardDeleteDocument(ctx: WriteContext, id: DocumentId): Promise<HardDeleteReceipt>;

  // Persistent record (P6b) that a hard delete left the blob NOT confirmed gone.
  // Written by the erasure orchestrator AFTER the DB transaction commits (the
  // blob delete is necessarily post-commit), so it cannot live in the in-tx
  // audit row. Writes one content-free audit_events row ('hard_delete_document_
  // incomplete', a short failure reason — never document content) so an
  // incomplete erasure is flagged for retry in the accountability trail, not only
  // in the ephemeral receipt. Tenant-scoped.
  recordIncompleteErasure(
    ctx: WriteContext,
    params: { readonly documentId: DocumentId; readonly reason: string },
  ): Promise<void>;

  // Extractor versions ------------------------------------------------------
  // Idempotent: returns the existing row if the natural key already exists.
  upsertExtractorVersion(ctx: WriteContext, params: NewExtractorVersion): Promise<ExtractorVersion>;

  // Embeddings --------------------------------------------------------------
  // Idempotent on (tenantId, targetKind, targetId, modelId). Re-embedding
  // the same target with the same model overwrites the vector and
  // access_tags; embedding under a different modelId adds a new row so
  // multiple model versions can coexist during a backfill.
  upsertEmbedding(ctx: WriteContext, params: NewEmbedding): Promise<Embedding>;

  // Telemetry ---------------------------------------------------------------
  // Append a row to llm_calls. Called by provider implementations on every
  // LLM/embedding call (success and failure) so cost telemetry is complete.
  // Application code does not call this directly.
  insertLlmCall(ctx: WriteContext, params: NewLlmCall): Promise<void>;
  // Append a row to query_events (per-query telemetry, D2). Written by the
  // query pipeline for every answered query. No question text / content.
  insertQueryEvent(ctx: WriteContext, params: NewQueryEvent): Promise<void>;

  // Citation telemetry: one row per cited source paragraph (content-free). Best-
  // effort at the call site — like query_events, a failed write must never break
  // the answer it describes. Empty input is a no-op.
  insertCitationEvents(ctx: WriteContext, events: readonly CitationEventInput[]): Promise<void>;

  // Audit -------------------------------------------------------------------
  // Append ONE accountability row to audit_events for a shared-graph action that
  // has no dedicated mutation method of its own to write the audit (today: a
  // steward approving a learned-rule promotion — the rule write lives in the
  // LearningStore). updateEntity/updateEdge still write their own audit rows in
  // their own transaction; this is the explicit escape hatch for actions that
  // don't. Generic (opaque action/targetKind/details). Tenant-scoped. Call it
  // inside a withTransaction / shared tx so the audit row commits or rolls back
  // WITH the action it records.
  recordAuditEvent(ctx: WriteContext, params: AuditEventInput): Promise<void>;

  // Review queue (P6a) -------------------------------------------------------
  // Enqueue a SUGGESTED correction: status 'pending', ZERO shared effect (the
  // golden rule — no suggestion becomes a shared fact without a steward
  // approval). Any authenticated user may call it. The caller must first read the
  // TARGET with the USER's own ReadContext and copy its access_tags onto
  // params.accessTags so the queued item stays access-gated to that target's
  // audience. proposed_by = ctx.actor.
  enqueueReviewItem(ctx: WriteContext, params: NewReviewItem): Promise<ReviewItem>;
  // Resolve a PENDING item: set status (approved|rejected) + reviewed_by/at.
  // Does NOT apply the change — applying an approved correction is
  // updateEntity/updateEdge, audited there. Tenant-scoped; only acts on a
  // still-pending row (re-resolving throws NotFound). The steward CAPABILITY
  // check + the access-gated getReviewItem are the layer-above's responsibility
  // (write authorisation belongs above the engine, like every other write).
  resolveReviewItem(
    ctx: WriteContext,
    id: ReviewItemId,
    decision: ReviewDecision,
  ): Promise<ReviewItem>;
  // Erasure-support sweep (G2a: F54/F55 DSAR legs): delete PENDING review items
  // whose (target_kind, target_id) is in the given set — a stale pending item
  // still carries the proposed payload for a target that no longer exists, and
  // could otherwise be approved after erasure. PENDING ONLY: resolved items are
  // the decision trail and are never deleted here (their payloads are handled
  // by the F54 resolved-item retention scrub, not erasure). Tenant-scoped;
  // deletes regardless of access tags (writes carry no tag filter, exactly like
  // resolveReviewItem). Returns the count (content-free, for the caller's
  // receipt + audit row). Empty ids → 0, no-op.
  deletePendingReviewItemsByTargets(
    ctx: WriteContext,
    targetKind: string,
    targetIds: readonly string[],
  ): Promise<number>;
  // Retention scrub for RESOLVED review items (F54): approved/rejected items
  // whose reviewed_at is older than `cutoff` lose their content-bearing fields
  // in place — proposed_change → '{}', note → NULL — while status, proposer,
  // reviewer, and timestamps survive as the audit/decision trail. PENDING items
  // are never aged out silently (only a resolution or an erasure sweep removes
  // them). Tenant-scoped; idempotent (an already-scrubbed row no longer
  // matches). Returns the content-free count for the sweep's audit row.
  scrubResolvedReviewItems(ctx: WriteContext, cutoff: Date): Promise<number>;

  // Transactions ------------------------------------------------------------
  withTransaction<T>(ctx: WriteContext, fn: (tx: GraphStore) => Promise<T>): Promise<T>;
}

// Concrete implementations implement both interfaces.
export type GraphStore = GraphStoreReader & GraphStoreWriter;

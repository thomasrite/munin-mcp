// Branded IDs, domain types, contexts, and the INTERNAL_BYPASS token.
//
// This file is the public surface that downstream engine modules and the web
// application use when they talk to the GraphStore. The shape here is
// deliberately narrow.

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------
//
// A parameter-swap bug (e.g. calling `getEntity(ctx, documentId)`) becomes
// a compile error. The cost is one cast in the corresponding factory; the
// benefit accrues for the project's lifetime.

declare const idBrand: unique symbol;
type Brand<K, T> = K & { readonly [idBrand]: T };

export type TenantId = Brand<string, 'TenantId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type EdgeId = Brand<string, 'EdgeId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type ParagraphId = Brand<string, 'ParagraphId'>;
export type ExtractorVersionId = Brand<string, 'ExtractorVersionId'>;
export type ActorId = Brand<string, 'ActorId'>;

export const newTenantId = (): TenantId => crypto.randomUUID() as TenantId;
export const newEntityId = (): EntityId => crypto.randomUUID() as EntityId;
export const newEdgeId = (): EdgeId => crypto.randomUUID() as EdgeId;
export const newDocumentId = (): DocumentId => crypto.randomUUID() as DocumentId;
export const newParagraphId = (): ParagraphId => crypto.randomUUID() as ParagraphId;
export const newExtractorVersionId = (): ExtractorVersionId =>
  crypto.randomUUID() as ExtractorVersionId;

// Existing-id wrappers for cases where the value comes from outside (DB row,
// HTTP payload, configuration). These do *not* validate — callers are
// expected to have already verified the source.
export const asTenantId = (value: string): TenantId => value as TenantId;
export const asEntityId = (value: string): EntityId => value as EntityId;
export const asEdgeId = (value: string): EdgeId => value as EdgeId;
export const asDocumentId = (value: string): DocumentId => value as DocumentId;
export const asParagraphId = (value: string): ParagraphId => value as ParagraphId;
export const asExtractorVersionId = (value: string): ExtractorVersionId =>
  value as ExtractorVersionId;
export const asActorId = (value: string): ActorId => value as ActorId;

// ---------------------------------------------------------------------------
// INTERNAL_BYPASS token
// ---------------------------------------------------------------------------
//
// Construct with `internalBypass(callSite, reason)`. Both arguments must be
// non-empty. The token is opaque and brand-checked; you cannot fabricate one
// without going through the constructor.
//
// Every read that consumes a bypass token inserts one row into
// `internal_bypass_log` in the same transaction as the read.

// Runtime brand. The symbol is module-private and never exported, so a
// caller cannot fabricate an InternalBypassToken structurally — they must
// go through `internalBypass(callSite, reason)`.
const internalBypassBrand: unique symbol = Symbol('internalBypassBrand');

export interface InternalBypassToken {
  readonly [internalBypassBrand]: true;
  readonly callSite: string;
  readonly reason: string;
}

export function internalBypass(callSite: string, reason: string): InternalBypassToken {
  if (!callSite.trim()) {
    throw new Error('internalBypass requires a non-empty callSite');
  }
  if (!reason.trim()) {
    throw new Error('internalBypass requires a non-empty reason');
  }
  return { [internalBypassBrand]: true, callSite, reason };
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

// Regular reads: caller's tags drive the access filter via any-of
// intersection. accessTags = [] means "caller has no tags, sees nothing"
// — never "no filter".
export interface RegularReadContext {
  readonly kind: 'regular';
  readonly tenantId: TenantId;
  readonly accessTags: readonly string[];
  readonly actor: ActorId;
}

// Bypass reads: the engine skips the access-tag filter for the duration of
// the operation and writes an `internal_bypass_log` row in the same
// transaction. Tenant isolation is *not* bypassed.
export interface BypassReadContext {
  readonly kind: 'bypass';
  readonly tenantId: TenantId;
  readonly bypass: InternalBypassToken;
  readonly actor: ActorId;
}

export type ReadContext = RegularReadContext | BypassReadContext;

// Writes: no accessTags parameter — write authorisation belongs to the
// layer above. The engine still enforces tenant isolation (writes always
// target ctx.tenantId).
export interface WriteContext {
  readonly tenantId: TenantId;
  readonly actor: ActorId;
}

// ---------------------------------------------------------------------------
// Provenance — discriminated union replacing the five-nullable-columns row
// ---------------------------------------------------------------------------

export type Provenance =
  | DocumentExtractProvenance
  | ConnectorProvenance
  | ManualProvenance
  | SystemProvenance;

// `confidence` is a GENERIC, producer-defined provenance signal in [0,1] (the DB
// columns on entities + edges carry a `0..1` CHECK). It is intentionally NOT named
// for any one producer's interpretation — its meaning is defined by whichever
// producer wrote the row (Rule 1: the engine stays neutral). Critically, for the
// document_extract kind it is the extract-time VERBATIM-MATCH heuristic, which means
// "copied exactly", NEVER "factually correct" — see each field below and
// computeVerbatimConfidence. (Experiment C confirmed the name can mislead; we keep
// the field generic and document the semantics rather than couple it to one
// producer.)
export interface DocumentExtractProvenance {
  readonly kind: 'document_extract';
  readonly documentId: DocumentId;
  readonly paragraphId: ParagraphId;
  readonly extractorVersionId: ExtractorVersionId;
  // VERBATIM-MATCH heuristic (see computeVerbatimConfidence): 1.0 = every extracted
  // property value appears literally in the source paragraph ("copied exactly");
  // null = it does not (inferred/paraphrased). This measures literal copying, NOT
  // correctness — a 1.0 fact can still be semantically wrong (e.g. a negated outcome,
  // a mis-attributed subject; the design notes).
  readonly confidence: number | null;
}

export interface ConnectorProvenance {
  readonly kind: 'connector';
  readonly connectorPackage: string;
  readonly documentId: DocumentId | null;
  // Producer-defined [0,1] confidence for the connector's own facts — NOT the
  // document_extract verbatim heuristic; each connector defines its own semantics.
  readonly confidence: number | null;
}

export interface ManualProvenance {
  readonly kind: 'manual';
  // Producer-defined [0,1] confidence for a human-/system-entered fact — semantics
  // are the entering producer's, not the verbatim heuristic.
  readonly confidence: number | null;
}

export interface SystemProvenance {
  readonly kind: 'system';
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Entity {
  readonly id: EntityId;
  readonly tenantId: TenantId;
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly accessTags: readonly string[];
  readonly provenance: Provenance;
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface Edge {
  readonly id: EdgeId;
  readonly tenantId: TenantId;
  readonly type: string;
  readonly fromEntityId: EntityId;
  readonly toEntityId: EntityId;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly accessTags: readonly string[];
  readonly provenance: Provenance;
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface Document {
  readonly id: DocumentId;
  readonly tenantId: TenantId;
  readonly externalId: string | null;
  readonly connectorPackage: string | null;
  readonly title: string;
  readonly mimeType: string | null;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  readonly blobStorageUri: string;
  readonly sourceModifiedAt: Date | null;
  // Versioning / validity window (P3a). A document with all-null version fields
  // is a "version of one": current, never superseded. `validTo === null` ⇒ the
  // current/live version; a set `validTo` marks a superseded version (still
  // retrievable, ranked lower at query time). The engine treats these as generic
  // validity/supersession — never a domain concept.
  readonly versionGroupId: DocumentId | null;
  readonly versionSeq: number | null;
  readonly supersedesDocumentId: DocumentId | null;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  // OPAQUE configuration-supplied sensitivity class id (F33). The engine NEVER
  // consults this for permission (access stays access-tag-only) — it is a
  // display/metadata field. null when no class was picked at ingest.
  readonly sensitivityClassId: string | null;
  readonly accessTags: readonly string[];
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface ParagraphStructure {
  readonly headingPath?: readonly string[];
  readonly page?: number;
  readonly ordinalWithinSection?: number;
}

export interface Paragraph {
  readonly id: ParagraphId;
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
  readonly paragraphIndex: number;
  readonly page: number | null;
  readonly text: string;
  readonly structure: ParagraphStructure;
  readonly accessTags: readonly string[];
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface ExtractorVersion {
  readonly id: ExtractorVersionId;
  readonly tenantId: TenantId;
  readonly configurationId: string;
  readonly configurationVersion: string;
  readonly schemaHash: string;
  readonly promptHash: string;
  readonly modelId: string;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Write parameters
// ---------------------------------------------------------------------------

export interface NewEntity {
  readonly id?: EntityId;
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly accessTags: readonly string[];
  readonly provenance: Provenance;
}

export interface NewEdge {
  readonly id?: EdgeId;
  readonly type: string;
  readonly fromEntityId: EntityId;
  readonly toEntityId: EntityId;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly accessTags: readonly string[];
  readonly provenance: Provenance;
}

export interface NewDocument {
  readonly id?: DocumentId;
  readonly externalId?: string;
  readonly connectorPackage?: string;
  readonly title: string;
  readonly mimeType?: string;
  readonly byteSize?: bigint;
  readonly sha256?: string;
  readonly blobStorageUri: string;
  readonly sourceModifiedAt?: Date;
  readonly accessTags: readonly string[];
  // 64-bit SimHash fingerprint (P3a). Hex string; used for near-dup linking.
  readonly simhash?: string;
  // Versioning (P3a). Set by the ingestion pipeline when a changed document with
  // the same (tenant, connector, externalId) is re-ingested; left unset for a
  // first version (a "version of one"). validTo is NOT set here — the prior
  // version is marked superseded via GraphStoreWriter.supersedeDocument.
  readonly versionGroupId?: DocumentId;
  readonly versionSeq?: number;
  readonly supersedesDocumentId?: DocumentId;
  readonly validFrom?: Date;
  // OPAQUE configuration-supplied sensitivity class id (F33). Display/metadata
  // only — the engine never uses it for permission (that stays access-tag-only).
  readonly sensitivityClassId?: string;
}

// ---------------------------------------------------------------------------
// Duplicate links (P3a) — near/semantic duplicates are LINKED, never merged.
// ---------------------------------------------------------------------------

export type DocumentDuplicateMethod = 'near' | 'semantic';

// A document's near-dup fingerprint, for the bounded ingest-time scan. The
// engine compares fingerprints by Hamming distance in application code.
export interface DocumentFingerprint {
  readonly id: DocumentId;
  readonly simhash: string;
}

// A recorded duplicate link between two documents. Both endpoints stay fully
// ingested and retrievable — the link is metadata, never a merge or a skip.
export interface DocumentDuplicateLink {
  readonly documentId: DocumentId;
  readonly duplicateOfDocumentId: DocumentId;
  readonly method: DocumentDuplicateMethod;
  // Similarity in [0,1]: SimHash similarity (near) or cosine similarity (semantic).
  readonly score: number;
  readonly createdAt: Date;
}

export interface NewDocumentDuplicate {
  readonly documentId: DocumentId;
  readonly duplicateOfDocumentId: DocumentId;
  readonly method: DocumentDuplicateMethod;
  readonly score: number;
}

export interface NewParagraph {
  readonly id?: ParagraphId;
  readonly documentId: DocumentId;
  readonly paragraphIndex: number;
  readonly page?: number;
  readonly text: string;
  readonly structure?: ParagraphStructure;
  readonly accessTags: readonly string[];
}

export interface NewExtractorVersion {
  readonly id?: ExtractorVersionId;
  readonly configurationId: string;
  readonly configurationVersion: string;
  readonly schemaHash: string;
  readonly promptHash: string;
  readonly modelId: string;
}

export interface EntityPatch {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly accessTags?: readonly string[];
  readonly confidence?: number | null;
}

export interface EdgePatch {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly accessTags?: readonly string[];
  readonly confidence?: number | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface EntityQuery {
  readonly types?: readonly string[];
  readonly createdAfter?: Date;
  // Generic property-equals filter (M1.2): match entities whose property bag has
  // `property` equal to `value` (string comparison on the JSON text value). The
  // engine treats both as opaque — the CALLER (configuration) decides which
  // property is an identity/exact key. Powers gather-by-identity (key-gather) and
  // relational/by-criteria reads. Access-tag filtered like every read: the result
  // set AND its `total` count are scoped to caller-visible rows (the filter is
  // applied BEFORE counting), so a count can never betray out-of-clearance rows.
  readonly propertyEquals?: { readonly property: string; readonly value: string };
  readonly limit?: number;
  readonly offset?: number;
}

export interface EdgeQuery {
  readonly types?: readonly string[];
  readonly fromEntityId?: EntityId;
  readonly toEntityId?: EntityId;
  readonly createdAfter?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface NeighbourQuery {
  readonly edgeTypes?: readonly string[];
  readonly direction: 'out' | 'in' | 'both';
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export type EntityPage = Page<Entity>;
export type EdgePage = Page<Edge>;

// Document listing (D2). Documents carry no `type`; recent-ingestions lists
// just page by recency. Access-tag filtered like every content read.
export interface DocumentQuery {
  readonly createdAfter?: Date;
  readonly limit?: number;
  readonly offset?: number;
}
export type DocumentPage = Page<Document>;

// query_events telemetry (D2). Read shape for the dashboard's recent-activity
// panel (no question text — telemetry carries no content/PII).
export type QueryEventStatus = 'answered' | 'no_evidence' | 'error';
export interface QueryEvent {
  readonly actor: ActorId;
  readonly status: QueryEventStatus;
  readonly resultCount: number;
  readonly latencyMs: number;
  readonly occurredAt: Date;
}
export interface NewQueryEvent {
  readonly actor: ActorId;
  readonly status: QueryEventStatus;
  readonly resultCount: number;
  readonly latencyMs: number;
}

// One cited source for the citation-frequency telemetry (the learning-loop seed).
// Content-free: the cited paragraph + its document, nothing else. The actor +
// tenant come from the WriteContext.
export interface CitationEventInput {
  readonly paragraphId: ParagraphId;
  readonly documentId: DocumentId;
}

// One accountability row for a shared-graph action that has no dedicated mutation
// method to ride (e.g. approving a learned-rule promotion — the rule write lives
// in the LearningStore, so its audit can't piggyback on updateEntity). Generic:
// action / targetKind / details are opaque strings/JSON the engine stores
// verbatim, naming no vertical concept. Mirrors the columns the private
// per-mutation audit writer already populates.
export interface AuditEventInput {
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly accessTagsUsed: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

// READ shape for an audit_events row (listAuditEvents). Content-free by
// CONSTRUCTION at the read boundary: only the accountability columns are
// projected — who (actor), what action, which target (kind + id), which tags
// were exercised, when. The free-form `details` jsonb is deliberately NOT
// surfaced: it is an open bag a writer may (and already does — e.g. an erased
// actor's id) put identifiers into, so projecting it verbatim would make
// content-freedom a matter of every writer's discipline rather than a property
// of this read. A future caller that needs a specific, known-safe detail should
// add a narrow typed field here, never re-expose the raw bag. `targetId` is
// nullable: some recorded actions (a list/search read) have no single natural
// target; and note it names the accessed record's id REGARDLESS of the viewer's
// own clearance — see listAuditEvents for why this surface must be admin/DPO-gated.
export interface AuditEventRecord {
  readonly actor: ActorId;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly accessTagsUsed: readonly string[];
  readonly occurredAt: Date;
}

// One graph-shape summary row: how many live entities of a given `type` the
// caller can see. The aggregate counterpart to findEntities for an overview
// surface — access-tag filtered exactly like findEntities, so a type the caller
// cannot see contributes nothing (never leaks its existence or its volume).
export interface EntityTypeCount {
  readonly type: string;
  readonly count: number;
}

// Aggregate graph statistics for an overview surface (getGraphStats). All counts
// are over LIVE rows the caller is permitted to see — access-tag filtered like
// every content read, so the numbers never betray out-of-clearance records.
export interface GraphStats {
  // Live entity counts grouped by type, highest count first then type. Empty
  // when the caller can see nothing (fail-closed).
  readonly entitiesByType: readonly EntityTypeCount[];
  // Total live, caller-visible entities (the sum of entitiesByType counts).
  readonly totalEntities: number;
  // Total live, caller-visible edges.
  readonly totalEdges: number;
}

// Where a recorded LLM/embedding call ran, derived from the `region` tag the
// provider stamped on the llm_calls row. Generic infrastructure telemetry, NOT a
// vertical concept: `on_device` = a local model (region 'local'); `stub` = the
// zero-spend test provider (region 'stub'); `cloud` = any other region (a real
// off-device call). The classification is the engine's own provider-tag
// knowledge, so callers don't re-derive it from raw strings.
export type LlmCallLocation = 'on_device' | 'cloud' | 'stub';

// READ shape for one llm_calls row (listLlmCalls) — the per-call activity feed
// behind a "where did my data go" receipts surface. Content-free: tokens, cost,
// region, model, latency, and an optional document context — never prompt,
// completion, or any content/PII.
export interface LlmCallRecord {
  readonly purpose: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
  readonly modelId: string;
  readonly region: string;
  readonly location: LlmCallLocation;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  // Cost estimate in pence; null when no per-token cost model was loaded.
  readonly costEstimatePence: number | null;
  readonly latencyMs: number;
  readonly documentId: string | null;
  readonly occurredAt: Date;
}

// One region's aggregate in an egress summary: call count + summed cost, plus the
// on-device/cloud/stub classification of that region.
export interface LlmRegionUsage {
  readonly region: string;
  readonly location: LlmCallLocation;
  readonly calls: number;
  // Summed cost estimate in pence; rows with no cost model contribute 0.
  readonly costEstimatePence: number;
}

// A single location bucket's totals in the egress summary.
export interface LlmLocationTotals {
  readonly calls: number;
  readonly costEstimatePence: number;
}

// Tenant-scoped region/egress summary (summariseLlmCalls) for the receipts
// screen: per-region detail plus on-device-vs-cloud rollups, so a user can see
// at a glance how much of their AI usage stayed on the device vs left to a cloud
// provider. Tenant-scoped (no actor/access-tag columns on llm_calls — see the
// reader's doc comment) and distinct from the operator-facing, cross-tenant
// generateResidencyReport.
export interface LlmEgressSummary {
  readonly byRegion: readonly LlmRegionUsage[];
  readonly onDevice: LlmLocationTotals;
  readonly cloud: LlmLocationTotals;
  readonly stub: LlmLocationTotals;
  readonly totalCalls: number;
  readonly totalCostEstimatePence: number;
}

export interface ExtractorVersionNaturalKey {
  readonly configurationId: string;
  readonly schemaHash: string;
  readonly promptHash: string;
  readonly modelId: string;
}

// ---------------------------------------------------------------------------
// LLM call telemetry — written by providers on every call.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Embeddings — vectors attached to paragraphs (and, later, entities)
// ---------------------------------------------------------------------------

declare const embeddingIdBrand: unique symbol;
export type EmbeddingId = string & { readonly [embeddingIdBrand]: 'EmbeddingId' };
export const newEmbeddingId = (): EmbeddingId => crypto.randomUUID() as EmbeddingId;
export const asEmbeddingId = (value: string): EmbeddingId => value as EmbeddingId;

export interface Embedding {
  readonly id: EmbeddingId;
  readonly tenantId: TenantId;
  readonly targetKind: 'paragraph' | 'entity';
  readonly targetId: string;
  readonly modelId: string;
  readonly vector: readonly number[];
  readonly accessTags: readonly string[];
  readonly createdAt: Date;
}

export interface NewEmbedding {
  readonly id?: EmbeddingId;
  readonly targetKind: 'paragraph' | 'entity';
  readonly targetId: string;
  readonly modelId: string;
  readonly vector: readonly number[];
  // If omitted, the database trigger copies access_tags from the underlying
  // paragraph (target_kind='paragraph' only). Explicit values still take
  // precedence; supply when bootstrapping orphan embeddings.
  readonly accessTags?: readonly string[];
}

export interface VectorSearchQuery {
  readonly modelId: string;
  readonly k: number;
  readonly queryVector: readonly number[];
  // Optional headroom: HNSW returns top-k*alpha candidates which are then
  // filtered post-scan. Useful if the access filter is highly restrictive
  // and the raw top-k regularly returns nothing visible. Default 1.0.
  readonly expansionAlpha?: number;
}

export interface VectorSearchResult {
  readonly embeddingId: EmbeddingId;
  readonly targetKind: 'paragraph' | 'entity';
  readonly targetId: string;
  readonly distance: number; // cosine distance: 0 = identical, 2 = opposite
  readonly accessTags: readonly string[];
}

// Lexical (keyword / full-text) search over paragraph text — the complement to
// vector search for exact terms, proper nouns, codes, and spelling variants that
// semantic similarity ranks poorly. Same tenant + access-tag + soft-delete
// filtering as every read (no separate permission path).
export interface KeywordSearchQuery {
  readonly query: string;
  readonly k: number;
}

export interface KeywordSearchResult {
  // Always a paragraph today (keyword search is over paragraph text).
  readonly targetKind: 'paragraph';
  readonly targetId: string;
  // Lexical relevance (Postgres ts_rank_cd): HIGHER = more relevant. The inverse
  // sense of vector `distance` — callers fuse by RANK, not raw score, so the
  // incomparable scales never mix.
  readonly rank: number;
  readonly accessTags: readonly string[];
}

export interface NewLlmCall {
  readonly purpose: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
  readonly modelId: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly region: string;
  readonly extractorVersionId?: ExtractorVersionId;
  readonly documentId?: DocumentId;
  readonly failed?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Review queue (P6a) — governed corrections.
// ---------------------------------------------------------------------------
//
// A SUGGESTED correction enters the queue 'pending' with ZERO shared effect; a
// steward later APPROVES (the change is applied to the shared graph, audited) or
// REJECTS. Deliberately GENERIC so the post-pilot learning loop reuses this ONE
// queue: `targetKind` and `proposedChange` are OPAQUE — the engine stores and
// returns them verbatim, never interpreting either.

declare const reviewItemIdBrand: unique symbol;
export type ReviewItemId = string & { readonly [reviewItemIdBrand]: 'ReviewItemId' };
export const newReviewItemId = (): ReviewItemId => crypto.randomUUID() as ReviewItemId;
export const asReviewItemId = (value: string): ReviewItemId => value as ReviewItemId;

// Lifecycle: 'pending' (no shared effect) → 'approved' | 'rejected'. Stored as an
// opaque text column so the learning loop can add states without a migration;
// this union is the set used today.
export type ReviewItemStatus = 'pending' | 'approved' | 'rejected';

export interface ReviewItem {
  readonly id: ReviewItemId;
  readonly tenantId: TenantId;
  // OPAQUE, extensible kind ('entity'/'edge' now; 'learned_rule' etc. later) —
  // the engine never interprets it.
  readonly targetKind: string;
  // The target's id (an entity/edge uuid today); null for a target_kind that is
  // not a graph row (e.g. a proposed rule whose identity lives in proposedChange).
  readonly targetId: string | null;
  // OPAQUE correction payload — the patch the web layer applies on approval.
  readonly proposedChange: Readonly<Record<string, unknown>>;
  readonly proposedBy: ActorId;
  readonly status: ReviewItemStatus;
  // The TARGET's access tags, copied at enqueue — the queue read access-gates on
  // these (a steward sees only items whose target they may see).
  readonly accessTags: readonly string[];
  readonly reviewedBy: ActorId | null;
  readonly reviewedAt: Date | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewReviewItem {
  readonly id?: ReviewItemId;
  readonly targetKind: string;
  readonly targetId?: string | null;
  readonly proposedChange: Readonly<Record<string, unknown>>;
  // The TARGET's access tags. The web layer reads the target with the user's OWN
  // ReadContext first, then copies its tags here so the queued item is visible to
  // exactly the stewards who may see the target — never broader.
  readonly accessTags: readonly string[];
  // Optional free-text reason from the suggester (small; never raw content).
  readonly note?: string | null;
}

export interface ReviewQueueQuery {
  readonly limit?: number;
}

export interface ReviewDecision {
  // The terminal state to set. The engine sets status/reviewedBy/reviewedAt only;
  // APPLYING an approved change (updateEntity/updateEdge) is the caller's job and
  // is audited there.
  readonly decision: Exclude<ReviewItemStatus, 'pending'>;
}

// ---------------------------------------------------------------------------
// Right-to-erasure (P6b) — per-document hard delete.
// ---------------------------------------------------------------------------

// Content-free tally of the rows removed by a hard delete (for the receipt + the
// audit details). Counts only — never document content. `paragraphs`,
// `citationEvents`, and `duplicates` are removed by ON DELETE CASCADE from the
// document row; `embeddings`, `entities`, and `edges` are removed explicitly
// (their FKs are polymorphic / ON DELETE SET NULL, so a naive delete would
// ORPHAN them, not erase them).
//
// Count semantics (the no-entity-dedup model, decisions 14): `edges` counts edges
// whose provenance `source_document_id` is this document. Because the engine does
// NO cross-document entity sharing, every edge incident to one of the doc's
// entities is itself sourced from this doc, so that figure equals all edges
// removed; if a future writer ever shared entities across documents, an edge from
// another doc incident to an erased entity would be cascade-removed but not
// counted here. `citationEvents` counts rows whose `document_id` is this doc
// (consistent with each citation's paragraph). These are exact for all
// engine-produced data; the receipt is a content-free erasure record, not a
// cross-document edge audit.
export interface DocumentErasureCounts {
  readonly embeddings: number;
  readonly entities: number;
  readonly edges: number;
  readonly paragraphs: number;
  readonly citationEvents: number;
  readonly duplicates: number;
  // PENDING review items whose target (an erased entity/edge) no longer exists
  // (F54): swept in the same transaction, so a stale suggestion carrying
  // document-derived values can never outlive — or be approved after — the
  // erasure. Resolved items are the decision trail and are not swept here.
  readonly reviewItems: number;
}

// The content-free receipt the DB-tx hard delete returns. Identifiers + counts +
// the blob URI to erase next — NO document content. The blob is NOT yet deleted
// at this point (the DB transaction commits first; honest erasure verifies the
// blob afterwards — see eraseDocument's ErasureReceipt).
export interface HardDeleteReceipt {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly blobUri: string;
  readonly deletedCounts: DocumentErasureCounts;
  readonly occurredAt: Date;
  readonly actor: ActorId;
}

// TEST-ONLY deliberately-vulnerable GraphStore reader wrapper.
//
// This is the automated "deliberate-bug-is-caught" canary for the permission
// suite. It wraps a real GraphStoreReader and, on every read, rewrites an
// incoming `regular` ReadContext into a `bypass` ReadContext before delegating.
// Bypass is the engine's *real* mechanism for dropping the access-tag filter
// (it keeps tenant isolation and soft-delete; it only removes the tag overlap),
// so this faithfully simulates the single most dangerous regression — "the
// access-tag filter was dropped" (PERMISSION-MUTATION-TESTS.md Mutation 1) —
// without touching production code or any private method.
//
// The permission matrix runs its access-tag visibility assertions against this
// wrapper and asserts they FAIL. If they stayed green, the assertions weren't
// actually sensitive to the access-tag filter and the suite would be giving
// false confidence. NOT exported from the package; tests import it directly.

import type { GraphStoreReader } from '../graph/graph-store';
import {
  type AuditEventRecord,
  type Document,
  type DocumentDuplicateLink,
  type DocumentFingerprint,
  type DocumentId,
  type DocumentPage,
  type DocumentQuery,
  type Edge,
  type EdgeId,
  type EdgePage,
  type EdgeQuery,
  type Embedding,
  type Entity,
  type EntityId,
  type EntityPage,
  type EntityQuery,
  type ExtractorVersion,
  type ExtractorVersionNaturalKey,
  type GraphStats,
  type KeywordSearchQuery,
  type KeywordSearchResult,
  type LlmCallRecord,
  type LlmEgressSummary,
  type NeighbourQuery,
  type Paragraph,
  type ParagraphId,
  type QueryEvent,
  type ReadContext,
  type ReviewItem,
  type ReviewItemId,
  type ReviewQueueQuery,
  type VectorSearchQuery,
  type VectorSearchResult,
  internalBypass,
} from '../graph/types';

// Rewrite a regular context into a bypass context (dropping the access-tag
// filter). Bypass contexts pass through unchanged.
function downgrade(ctx: ReadContext): ReadContext {
  if (ctx.kind !== 'regular') return ctx;
  return {
    kind: 'bypass',
    tenantId: ctx.tenantId,
    bypass: internalBypass(
      'canary.vulnerable-store',
      'deliberate test weakness: simulates a dropped access-tag filter',
    ),
    actor: ctx.actor,
  };
}

// Implements only the reader surface — that is where access-tag enforcement
// lives and what the canary needs to probe.
export class VulnerableGraphStoreReader implements GraphStoreReader {
  constructor(private readonly inner: GraphStoreReader) {}

  getEntity(ctx: ReadContext, id: EntityId): Promise<Entity | null> {
    return this.inner.getEntity(downgrade(ctx), id);
  }

  getEntitiesByIds(ctx: ReadContext, ids: readonly EntityId[]): Promise<readonly Entity[]> {
    return this.inner.getEntitiesByIds(downgrade(ctx), ids);
  }

  findEntities(ctx: ReadContext, query: EntityQuery): Promise<EntityPage> {
    return this.inner.findEntities(downgrade(ctx), query);
  }

  findEntitiesByParagraphIds(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<readonly Entity[]> {
    return this.inner.findEntitiesByParagraphIds(downgrade(ctx), paragraphIds);
  }

  getEdge(ctx: ReadContext, id: EdgeId): Promise<Edge | null> {
    return this.inner.getEdge(downgrade(ctx), id);
  }

  findEdges(ctx: ReadContext, query: EdgeQuery): Promise<EdgePage> {
    return this.inner.findEdges(downgrade(ctx), query);
  }

  getNeighbours(
    ctx: ReadContext,
    entityId: EntityId,
    query: NeighbourQuery,
  ): Promise<{ entities: readonly Entity[]; edges: readonly Edge[] }> {
    return this.inner.getNeighbours(downgrade(ctx), entityId, query);
  }

  getGraphStats(ctx: ReadContext): Promise<GraphStats> {
    return this.inner.getGraphStats(downgrade(ctx));
  }

  findParagraphsPendingExtraction(
    ctx: ReadContext,
    opts: { readonly schemaHash: string },
  ): Promise<readonly Paragraph[]> {
    return this.inner.findParagraphsPendingExtraction(downgrade(ctx), opts);
  }

  getDocument(ctx: ReadContext, id: DocumentId): Promise<Document | null> {
    return this.inner.getDocument(downgrade(ctx), id);
  }

  getDocumentsByIds(ctx: ReadContext, ids: readonly DocumentId[]): Promise<readonly Document[]> {
    return this.inner.getDocumentsByIds(downgrade(ctx), ids);
  }

  getParagraph(ctx: ReadContext, id: ParagraphId): Promise<Paragraph | null> {
    return this.inner.getParagraph(downgrade(ctx), id);
  }

  getParagraphsByIds(ctx: ReadContext, ids: readonly ParagraphId[]): Promise<readonly Paragraph[]> {
    return this.inner.getParagraphsByIds(downgrade(ctx), ids);
  }

  findParagraphsByDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly Paragraph[]> {
    return this.inner.findParagraphsByDocument(downgrade(ctx), documentId);
  }

  findDocumentByHash(ctx: ReadContext, sha256: string): Promise<Document | null> {
    return this.inner.findDocumentByHash(downgrade(ctx), sha256);
  }

  findLatestLiveDocumentByExternalId(
    ctx: ReadContext,
    opts: { readonly connectorPackage: string; readonly externalId: string },
  ): Promise<Document | null> {
    return this.inner.findLatestLiveDocumentByExternalId(downgrade(ctx), opts);
  }

  findDocumentFingerprints(
    ctx: ReadContext,
    opts: { readonly limit: number },
  ): Promise<readonly DocumentFingerprint[]> {
    return this.inner.findDocumentFingerprints(downgrade(ctx), opts);
  }

  findDuplicatesForDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly DocumentDuplicateLink[]> {
    return this.inner.findDuplicatesForDocument(downgrade(ctx), documentId);
  }

  findDocuments(ctx: ReadContext, query: DocumentQuery): Promise<DocumentPage> {
    return this.inner.findDocuments(downgrade(ctx), query);
  }

  findRecentQueryEvents(
    ctx: ReadContext,
    query: { readonly limit?: number },
  ): Promise<readonly QueryEvent[]> {
    return this.inner.findRecentQueryEvents(downgrade(ctx), query);
  }

  countQueryEvents(
    ctx: ReadContext,
    query: { readonly since: Date; readonly byActor: boolean },
  ): Promise<number> {
    return this.inner.countQueryEvents(downgrade(ctx), query);
  }

  listAuditEvents(
    ctx: ReadContext,
    query?: { readonly since?: Date; readonly limit?: number },
  ): Promise<readonly AuditEventRecord[]> {
    return this.inner.listAuditEvents(downgrade(ctx), query);
  }

  listLlmCalls(
    ctx: ReadContext,
    query?: {
      readonly since?: Date;
      readonly limit?: number;
      readonly purpose?: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
    },
  ): Promise<readonly LlmCallRecord[]> {
    return this.inner.listLlmCalls(downgrade(ctx), query);
  }

  summariseLlmCalls(
    ctx: ReadContext,
    query?: { readonly since?: Date },
  ): Promise<LlmEgressSummary> {
    return this.inner.summariseLlmCalls(downgrade(ctx), query);
  }

  findExtractorVersion(
    ctx: ReadContext,
    key: ExtractorVersionNaturalKey,
  ): Promise<ExtractorVersion | null> {
    return this.inner.findExtractorVersion(downgrade(ctx), key);
  }

  searchByVector(
    ctx: ReadContext,
    query: VectorSearchQuery,
  ): Promise<readonly VectorSearchResult[]> {
    return this.inner.searchByVector(downgrade(ctx), query);
  }

  getEmbeddingsByTargets(
    ctx: ReadContext,
    query: {
      readonly targetKind: 'paragraph' | 'entity';
      readonly targetIds: readonly string[];
      readonly modelId: string;
    },
  ): Promise<readonly Embedding[]> {
    return this.inner.getEmbeddingsByTargets(downgrade(ctx), query);
  }

  searchByKeyword(
    ctx: ReadContext,
    query: KeywordSearchQuery,
  ): Promise<readonly KeywordSearchResult[]> {
    return this.inner.searchByKeyword(downgrade(ctx), query);
  }

  countCitationsByParagraph(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<ReadonlyMap<ParagraphId, number>> {
    return this.inner.countCitationsByParagraph(downgrade(ctx), paragraphIds);
  }

  countCitationsByDocument(
    ctx: ReadContext,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, number>> {
    return this.inner.countCitationsByDocument(downgrade(ctx), documentIds);
  }

  getReviewItem(ctx: ReadContext, id: ReviewItemId): Promise<ReviewItem | null> {
    return this.inner.getReviewItem(downgrade(ctx), id);
  }

  findPendingReviewItems(
    ctx: ReadContext,
    query?: ReviewQueueQuery,
  ): Promise<readonly ReviewItem[]> {
    return this.inner.findPendingReviewItems(downgrade(ctx), query);
  }
}

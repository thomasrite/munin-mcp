// Postgres-backed GraphStore implementation.
//
// Every read applies three filters in concert: tenant scoping, soft-delete
// exclusion, and (for regular reads) access-tag intersection. Bypass reads
// drop the access-tag filter and write a row to `internal_bypass_log` in
// the same transaction.
//
// Inside a `withTransaction` callback, the passed `tx` GraphStore uses the
// same DB transaction for every operation.

import {
  type SQL,
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { type AnyPgColumn, alias } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  auditEvents,
  citationEvents,
  documentDuplicates,
  documents,
  edges,
  embeddings,
  entities,
  extractorVersions,
  internalBypassLog,
  llmCalls,
  paragraphs,
  queryEvents,
  reviewQueue,
} from '../db/schema';

import {
  CrossTenantWriteError,
  GraphStoreError,
  InvalidProvenanceError,
  NotFoundError,
} from './errors';
import type { GraphStore } from './graph-store';
import {
  documentFromRow,
  edgeFromRow,
  embeddingFromRow,
  entityFromRow,
  extractorVersionFromRow,
  paragraphFromRow,
  provenanceToColumns,
  reviewItemFromRow,
} from './postgres-mapping';
import {
  type AuditEventInput,
  type AuditEventRecord,
  type CitationEventInput,
  type Document,
  type DocumentDuplicateLink,
  type DocumentDuplicateMethod,
  type DocumentErasureCounts,
  type DocumentFingerprint,
  type DocumentId,
  type DocumentPage,
  type DocumentQuery,
  type Edge,
  type EdgeId,
  type EdgePage,
  type EdgePatch,
  type EdgeQuery,
  type Embedding,
  type Entity,
  type EntityId,
  type EntityPage,
  type EntityPatch,
  type EntityQuery,
  type ExtractorVersion,
  type ExtractorVersionNaturalKey,
  type GraphStats,
  type HardDeleteReceipt,
  type KeywordSearchQuery,
  type KeywordSearchResult,
  type LlmCallLocation,
  type LlmCallRecord,
  type LlmEgressSummary,
  type LlmRegionUsage,
  type NeighbourQuery,
  type NewDocument,
  type NewDocumentDuplicate,
  type NewEdge,
  type NewEmbedding,
  type NewEntity,
  type NewExtractorVersion,
  type NewLlmCall,
  type NewParagraph,
  type NewQueryEvent,
  type NewReviewItem,
  type Paragraph,
  type ParagraphId,
  type Provenance,
  type QueryEvent,
  type ReadContext,
  type ReviewDecision,
  type ReviewItem,
  type ReviewItemId,
  type ReviewQueueQuery,
  type TenantId,
  type VectorSearchQuery,
  type VectorSearchResult,
  type WriteContext,
  asActorId,
  internalBypass,
  newDocumentId,
  newEdgeId,
  newEmbeddingId,
  newEntityId,
  newExtractorVersionId,
  newParagraphId,
  newReviewItemId,
} from './types';

// Internal query handle. The store's helpers are written once against the
// node-postgres (`postgres-js`) Drizzle types so every read filter, transaction,
// and raw-SQL path on the vector/keyword paths reads uniformly against one
// concrete driver shape (the public boundary is `GraphStoreDb`, below).
type Db = PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

// Public constructor input. Accepts either the node-postgres driver used by the
// hosted server OR the PGlite driver used by the local/desktop runtime (P1).
// PGlite is real Postgres compiled to WASM; both are `PgDatabase` subtypes
// exposing the identical Drizzle query API, so the store runs byte-for-byte the
// same SQL — same pgvector, same TEXT[]/GIN access tags, same triggers — against
// either backend. That is exactly why the local runtime reuses THIS store (and
// its P0 permission/no-leak guarantees) unchanged rather than adding a second
// implementation: widening the accepted handle is the ONLY store change needed.
type GraphStoreDb =
  | PostgresJsDatabase
  | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0]
  | PgliteDatabase
  | Parameters<Parameters<PgliteDatabase['transaction']>[0]>[0];

const DEFAULT_LIMIT = 100;

// F43: floor for pgvector's HNSW `ef_search` on the vector read path. The server
// default (40) silently under-recalls as the corpus grows and cannot return more
// than `ef_search` candidates — a recall cliff when the requested limit exceeds it.
// Experiment E recovered ~98% recall vs an exact scan at 10k docs with ef_search=200;
// 100 is the conservative floor (raised further when the requested limit is larger).
const HNSW_EF_SEARCH_FLOOR = 100;

// Regions the engine's own providers stamp on llm_calls rows for on-device
// inference (Ollama, the self-hosted cross-encoder). Anything not on-device and
// not the zero-spend stub is treated as a real cloud (off-device) call. Generic
// infrastructure classification — these are the engine's provider tags, NOT a
// vertical concept. Kept in sync with the providers' REGION constants.
const ON_DEVICE_REGIONS: ReadonlySet<string> = new Set(['local']);
const STUB_REGIONS: ReadonlySet<string> = new Set(['stub']);

// Classify an llm_calls region tag into on-device / cloud / stub for the
// tenant-scoped egress surfaces. Exported for the readers above and for tests.
export function classifyRegion(region: string): LlmCallLocation {
  if (ON_DEVICE_REGIONS.has(region)) return 'on_device';
  if (STUB_REGIONS.has(region)) return 'stub';
  return 'cloud';
}

// Serialise a JS string array into a Postgres array-literal so it round-trips
// through a `::text[]` cast unambiguously. Used for the access-tag overlap
// filter; exported only for testing.
export function toPgTextArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return '{}';
  return `{${values.map(escapeArrayElement).join(',')}}`;
}

function escapeArrayElement(value: string): string {
  // Elements containing special characters or whitespace must be
  // double-quoted; double quotes and backslashes inside are backslash-escaped.
  if (value === '' || value.toUpperCase() === 'NULL' || /[",\\{}\s]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

// The NAMES of the fields a patch changes — the content-free change summary
// recorded in an audit row. EntityPatch and EdgePatch share this shape. Never
// the VALUES: audit details must carry no entity/document content or PII.
function changedPatchFields(patch: {
  readonly properties?: unknown;
  readonly accessTags?: unknown;
  readonly confidence?: unknown;
}): string[] {
  const fields: string[] = [];
  if (patch.properties !== undefined) fields.push('properties');
  if (patch.accessTags !== undefined) fields.push('accessTags');
  if (patch.confidence !== undefined) fields.push('confidence');
  return fields;
}

export class PostgresGraphStore implements GraphStore {
  private readonly db: Db;

  constructor(db: GraphStoreDb) {
    // Both supported drivers (postgres-js, PGlite) implement the identical
    // Drizzle `PgDatabase` query API at runtime; the helpers are typed against
    // one concrete driver shape. Narrowing the handle here is a compile-time
    // convenience with no runtime effect — every statement is driver-agnostic
    // and the PGlite handle really does expose the same query API.
    this.db = db as Db;
  }

  static fromConnectionString(
    url: string,
    options?: postgres.Options<Record<string, never>>,
  ): {
    store: PostgresGraphStore;
    // The raw Drizzle handle, exposed so callers that build sibling stores or
    // cross-store orchestrations (e.g. the retention sweep, which spans the
    // LearningStore and this store in one transaction) reuse the SAME connection
    // — mirrors PgliteGraphStoreHandle.db.
    db: PostgresJsDatabase;
    close: () => Promise<void>;
  } {
    const client = postgres(url, options);
    const db = drizzle(client);
    return {
      store: new PostgresGraphStore(db),
      db,
      close: () => client.end({ timeout: 5 }),
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getEntity(ctx: ReadContext, id: EntityId): Promise<Entity | null> {
    return this.withBypassLogging(ctx, 'getEntity', { id }, (db) => this.getEntityRaw(db, ctx, id));
  }

  async getEntitiesByIds(ctx: ReadContext, ids: readonly EntityId[]): Promise<readonly Entity[]> {
    if (ids.length === 0) return [];
    return this.withBypassLogging(ctx, 'getEntitiesByIds', { count: ids.length }, (db) =>
      this.getEntitiesByIdsRaw(db, ctx, ids),
    );
  }

  async findEntitiesByParagraphIds(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<readonly Entity[]> {
    if (paragraphIds.length === 0) return [];
    return this.withBypassLogging(
      ctx,
      'findEntitiesByParagraphIds',
      { count: paragraphIds.length },
      async (db) => {
        const filters = this.readFilters(ctx, entities);
        filters.push(inArray(entities.sourceParagraphId, [...paragraphIds]));
        const rows = await db
          .select()
          .from(entities)
          .where(and(...filters));
        return rows.map(entityFromRow);
      },
    );
  }

  async findEntities(ctx: ReadContext, query: EntityQuery): Promise<EntityPage> {
    return this.withBypassLogging(ctx, 'findEntities', { query }, async (db) => {
      const filters = this.readFilters(ctx, entities);
      if (query.types && query.types.length > 0) {
        filters.push(inArray(entities.type, [...query.types]));
      }
      if (query.createdAfter) {
        filters.push(gt(entities.createdAt, query.createdAfter));
      }
      if (query.propertyEquals) {
        // JSON text-value equality; key + value are bind params. The access
        // filter (readFilters) is already in `filters`, so both the rows AND the
        // count below stay scoped to caller-visible rows — a key-gather can never
        // betray that out-of-clearance records exist.
        filters.push(
          sql`(${entities.properties} ->> ${query.propertyEquals.property}) = ${query.propertyEquals.value}`,
        );
      }

      const where = and(...filters);
      const limit = query.limit ?? DEFAULT_LIMIT;
      const offset = query.offset ?? 0;

      const rows = await db
        .select()
        .from(entities)
        .where(where)
        .orderBy(entities.createdAt)
        .limit(limit)
        .offset(offset);
      const totals = await db.select({ value: count() }).from(entities).where(where);
      return {
        items: rows.map(entityFromRow),
        total: Number(totals[0]?.value ?? 0),
      };
    });
  }

  async getEdge(ctx: ReadContext, id: EdgeId): Promise<Edge | null> {
    return this.withBypassLogging(ctx, 'getEdge', { id }, async (db) => {
      const filters = this.readFilters(ctx, edges);
      filters.push(eq(edges.id, id));
      const rows = await db
        .select()
        .from(edges)
        .where(and(...filters))
        .limit(1);
      return rows[0] ? edgeFromRow(rows[0]) : null;
    });
  }

  async findEdges(ctx: ReadContext, query: EdgeQuery): Promise<EdgePage> {
    return this.withBypassLogging(ctx, 'findEdges', { query }, async (db) => {
      const filters = this.readFilters(ctx, edges);
      if (query.types && query.types.length > 0) {
        filters.push(inArray(edges.type, [...query.types]));
      }
      if (query.fromEntityId) filters.push(eq(edges.fromEntityId, query.fromEntityId));
      if (query.toEntityId) filters.push(eq(edges.toEntityId, query.toEntityId));
      if (query.createdAfter) filters.push(gt(edges.createdAt, query.createdAfter));

      const where = and(...filters);
      const limit = query.limit ?? DEFAULT_LIMIT;
      const offset = query.offset ?? 0;

      const rows = await db
        .select()
        .from(edges)
        .where(where)
        .orderBy(edges.createdAt)
        .limit(limit)
        .offset(offset);
      const totals = await db.select({ value: count() }).from(edges).where(where);
      return {
        items: rows.map(edgeFromRow),
        total: Number(totals[0]?.value ?? 0),
      };
    });
  }

  async getNeighbours(
    ctx: ReadContext,
    entityId: EntityId,
    query: NeighbourQuery,
  ): Promise<{ entities: readonly Entity[]; edges: readonly Edge[] }> {
    return this.withBypassLogging(
      ctx,
      'getNeighbours',
      { entityId, direction: query.direction },
      async (db) => {
        // Start entity must itself be visible.
        const start = await this.getEntityRaw(db, ctx, entityId);
        if (!start) return { entities: [], edges: [] };

        // Edges with the access filter applied.
        const edgeFilters = this.readFilters(ctx, edges);
        if (query.edgeTypes && query.edgeTypes.length > 0) {
          edgeFilters.push(inArray(edges.type, [...query.edgeTypes]));
        }
        const directionFilter =
          query.direction === 'out'
            ? eq(edges.fromEntityId, entityId)
            : query.direction === 'in'
              ? eq(edges.toEntityId, entityId)
              : or(eq(edges.fromEntityId, entityId), eq(edges.toEntityId, entityId));
        if (directionFilter) edgeFilters.push(directionFilter);

        const limit = query.limit ?? DEFAULT_LIMIT;
        const candidateEdgeRows = await db
          .select()
          .from(edges)
          .where(and(...edgeFilters))
          .limit(limit);

        // Resolve far endpoints under the access filter. Edges whose far
        // endpoint is invisible are dropped.
        const farIds: EntityId[] = candidateEdgeRows.map((row) => {
          const from = String(row.fromEntityId) as EntityId;
          const to = String(row.toEntityId) as EntityId;
          return from === entityId ? to : from;
        });
        const visibleFar = await this.getEntitiesByIdsRaw(db, ctx, farIds);
        const visibleFarIds = new Set(visibleFar.map((e) => e.id));

        const visibleEdges = candidateEdgeRows.filter((row) => {
          const from = String(row.fromEntityId) as EntityId;
          const to = String(row.toEntityId) as EntityId;
          const farId = from === entityId ? to : from;
          return visibleFarIds.has(farId);
        });

        return {
          entities: visibleFar,
          edges: visibleEdges.map(edgeFromRow),
        };
      },
    );
  }

  async getGraphStats(ctx: ReadContext): Promise<GraphStats> {
    return this.withBypassLogging(ctx, 'getGraphStats', {}, async (db) => {
      // Entities grouped by type in ONE query (GROUP BY) — never N findEntities
      // calls. readFilters applies the SAME tenant + soft-delete + access-tag
      // filter as every read, so the GROUP BY counts only caller-visible rows.
      const entityFilters = this.readFilters(ctx, entities);
      const entityRows = await db
        .select({ type: entities.type, n: count() })
        .from(entities)
        .where(and(...entityFilters))
        .groupBy(entities.type)
        // Highest count first, then type — a stable, deterministic order.
        .orderBy(desc(count()), entities.type);

      // Edge total: one COUNT under the same read filter.
      const edgeFilters = this.readFilters(ctx, edges);
      const [edgeTotal] = await db
        .select({ n: count() })
        .from(edges)
        .where(and(...edgeFilters));

      const entitiesByType = entityRows.map((r) => ({ type: r.type, count: Number(r.n) }));
      const totalEntities = entitiesByType.reduce((sum, r) => sum + r.count, 0);
      return {
        entitiesByType,
        totalEntities,
        totalEdges: Number(edgeTotal?.n ?? 0),
      };
    });
  }

  async getDocument(ctx: ReadContext, id: DocumentId): Promise<Document | null> {
    return this.withBypassLogging(ctx, 'getDocument', { id }, async (db) => {
      const filters = this.readFilters(ctx, documents);
      filters.push(eq(documents.id, id));
      const rows = await db
        .select()
        .from(documents)
        .where(and(...filters))
        .limit(1);
      return rows[0] ? documentFromRow(rows[0]) : null;
    });
  }

  async getDocumentsByIds(
    ctx: ReadContext,
    ids: readonly DocumentId[],
  ): Promise<readonly Document[]> {
    if (ids.length === 0) return [];
    return this.withBypassLogging(ctx, 'getDocumentsByIds', { count: ids.length }, async (db) => {
      const filters = this.readFilters(ctx, documents);
      filters.push(inArray(documents.id, [...ids]));
      const rows = await db
        .select()
        .from(documents)
        .where(and(...filters));
      return rows.map(documentFromRow);
    });
  }

  async getParagraph(ctx: ReadContext, id: ParagraphId): Promise<Paragraph | null> {
    return this.withBypassLogging(ctx, 'getParagraph', { id }, async (db) => {
      const filters = this.readFilters(ctx, paragraphs);
      filters.push(eq(paragraphs.id, id));
      const rows = await db
        .select()
        .from(paragraphs)
        .where(and(...filters))
        .limit(1);
      return rows[0] ? paragraphFromRow(rows[0]) : null;
    });
  }

  async getParagraphsByIds(
    ctx: ReadContext,
    ids: readonly ParagraphId[],
  ): Promise<readonly Paragraph[]> {
    if (ids.length === 0) return [];
    return this.withBypassLogging(ctx, 'getParagraphsByIds', { count: ids.length }, async (db) => {
      const filters = this.readFilters(ctx, paragraphs);
      filters.push(inArray(paragraphs.id, [...ids]));
      const rows = await db
        .select()
        .from(paragraphs)
        .where(and(...filters));
      return rows.map(paragraphFromRow);
    });
  }

  async findParagraphsByDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly Paragraph[]> {
    return this.withBypassLogging(ctx, 'findParagraphsByDocument', { documentId }, async (db) => {
      const filters = this.readFilters(ctx, paragraphs);
      filters.push(eq(paragraphs.documentId, documentId));
      const rows = await db
        .select()
        .from(paragraphs)
        .where(and(...filters))
        .orderBy(paragraphs.paragraphIndex);
      return rows.map(paragraphFromRow);
    });
  }

  async findParagraphsPendingExtraction(
    ctx: ReadContext,
    opts: { readonly schemaHash: string },
  ): Promise<readonly Paragraph[]> {
    return this.withBypassLogging(
      ctx,
      'findParagraphsPendingExtraction',
      { schemaHash: opts.schemaHash },
      async (db) => {
        const filters = this.readFilters(ctx, paragraphs);
        // No live entity extracted from this paragraph under the current schema.
        filters.push(sql`NOT EXISTS (
          SELECT 1 FROM entities e
          JOIN extractor_versions ev ON ev.id = e.extractor_version_id
          WHERE e.source_paragraph_id = ${paragraphs.id}
            AND ev.schema_hash = ${opts.schemaHash}
            AND e.deleted_at IS NULL
        )`);
        const rows = await db
          .select()
          .from(paragraphs)
          .where(and(...filters))
          .orderBy(paragraphs.paragraphIndex);
        return rows.map(paragraphFromRow);
      },
    );
  }

  async findDocumentByHash(ctx: ReadContext, sha256: string): Promise<Document | null> {
    return this.withBypassLogging(ctx, 'findDocumentByHash', { sha256 }, async (db) => {
      const filters = this.readFilters(ctx, documents);
      filters.push(eq(documents.sha256, sha256));
      const rows = await db
        .select()
        .from(documents)
        .where(and(...filters))
        .limit(1);
      return rows[0] ? documentFromRow(rows[0]) : null;
    });
  }

  async findLatestLiveDocumentByExternalId(
    ctx: ReadContext,
    opts: { readonly connectorPackage: string; readonly externalId: string },
  ): Promise<Document | null> {
    return this.withBypassLogging(
      ctx,
      'findLatestLiveDocumentByExternalId',
      { connectorPackage: opts.connectorPackage, externalId: opts.externalId },
      async (db) => {
        const filters = this.readFilters(ctx, documents);
        filters.push(eq(documents.connectorPackage, opts.connectorPackage));
        filters.push(eq(documents.externalId, opts.externalId));
        // The current/live version is the one with no validTo. Exactly one such
        // row exists per (connector, externalId) at a time (superseding stamps
        // validTo); the order is a defensive tiebreak.
        filters.push(isNull(documents.validTo));
        const rows = await db
          .select()
          .from(documents)
          .where(and(...filters))
          .orderBy(desc(documents.versionSeq), desc(documents.createdAt))
          .limit(1);
        return rows[0] ? documentFromRow(rows[0]) : null;
      },
    );
  }

  async findDocumentFingerprints(
    ctx: ReadContext,
    opts: { readonly limit: number },
  ): Promise<readonly DocumentFingerprint[]> {
    return this.withBypassLogging(
      ctx,
      'findDocumentFingerprints',
      { limit: opts.limit },
      async (db) => {
        const filters = this.readFilters(ctx, documents);
        filters.push(sql`${documents.simhash} IS NOT NULL`);
        const rows = await db
          .select({ id: documents.id, simhash: documents.simhash })
          .from(documents)
          .where(and(...filters))
          .orderBy(desc(documents.createdAt))
          .limit(opts.limit);
        const out: DocumentFingerprint[] = [];
        for (const r of rows) {
          // simhash is NOT NULL by the filter; the narrowing keeps types honest.
          if (r.simhash !== null) out.push({ id: r.id as DocumentId, simhash: r.simhash });
        }
        return out;
      },
    );
  }

  async findDuplicatesForDocument(
    ctx: ReadContext,
    documentId: DocumentId,
  ): Promise<readonly DocumentDuplicateLink[]> {
    return this.withBypassLogging(ctx, 'findDuplicatesForDocument', { documentId }, async (db) => {
      // Both endpoints must be visible: a link is returned only when the caller
      // can see the queried document AND its counterpart. We join the link to
      // both endpoint `documents` rows (the queried side + the other side) and
      // apply the standard read filter to EACH, so a near/semantic link can
      // never reveal a document the caller is not cleared to see. Links are
      // bidirectional in intent, so we match `documentId` on either column and
      // alias the "other" document accordingly.
      const self = alias(documents, 'self_doc');
      const other = alias(documents, 'other_doc');
      const selfFilters = this.readFilters(ctx, self);
      const otherFilters = this.readFilters(ctx, other);
      const rows = await db
        .select({
          documentId: documentDuplicates.documentId,
          duplicateOfDocumentId: documentDuplicates.duplicateOfDocumentId,
          method: documentDuplicates.method,
          score: documentDuplicates.score,
          createdAt: documentDuplicates.createdAt,
        })
        .from(documentDuplicates)
        // `self` is the queried document; `other` is the counterpart. Which
        // physical column is which depends on the link direction, so the join
        // condition pairs them by "the queried id is on one side, the other id
        // on the opposite side".
        .innerJoin(
          self,
          and(
            eq(self.id, documentId),
            or(
              eq(documentDuplicates.documentId, documentId),
              eq(documentDuplicates.duplicateOfDocumentId, documentId),
            ),
          ),
        )
        .innerJoin(
          other,
          or(
            and(
              eq(documentDuplicates.documentId, documentId),
              eq(other.id, documentDuplicates.duplicateOfDocumentId),
            ),
            and(
              eq(documentDuplicates.duplicateOfDocumentId, documentId),
              eq(other.id, documentDuplicates.documentId),
            ),
          ),
        )
        .where(and(eq(documentDuplicates.tenantId, ctx.tenantId), ...selfFilters, ...otherFilters))
        .orderBy(desc(documentDuplicates.createdAt));
      return rows.map((r) => ({
        documentId: r.documentId as DocumentId,
        duplicateOfDocumentId: r.duplicateOfDocumentId as DocumentId,
        method: r.method as DocumentDuplicateMethod,
        score: Number(r.score),
        createdAt: r.createdAt,
      }));
    });
  }

  async findDocuments(ctx: ReadContext, query: DocumentQuery): Promise<DocumentPage> {
    return this.withBypassLogging(ctx, 'findDocuments', { query }, async (db) => {
      const filters = this.readFilters(ctx, documents);
      if (query.createdAfter) {
        filters.push(gt(documents.createdAt, query.createdAfter));
      }
      const where = and(...filters);
      const limit = query.limit ?? DEFAULT_LIMIT;
      const offset = query.offset ?? 0;

      const rows = await db
        .select()
        .from(documents)
        .where(where)
        .orderBy(desc(documents.createdAt))
        .limit(limit)
        .offset(offset);
      const totals = await db.select({ value: count() }).from(documents).where(where);
      return {
        items: rows.map(documentFromRow),
        total: Number(totals[0]?.value ?? 0),
      };
    });
  }

  async findRecentQueryEvents(
    ctx: ReadContext,
    query: { readonly limit?: number },
  ): Promise<readonly QueryEvent[]> {
    // Telemetry read: tenant + actor scoped, no access-tag filter (no content),
    // so intentionally NOT wrapped in withBypassLogging — there is no access
    // filter to bypass, and the row carries no document/entity content.
    const rows = await this.db
      .select()
      .from(queryEvents)
      .where(and(eq(queryEvents.tenantId, ctx.tenantId), eq(queryEvents.actor, ctx.actor)))
      .orderBy(desc(queryEvents.occurredAt))
      .limit(query.limit ?? DEFAULT_LIMIT);
    return rows.map((r) => ({
      actor: asActorId(r.actor),
      status: r.status,
      resultCount: r.resultCount,
      latencyMs: r.latencyMs,
      occurredAt: r.occurredAt,
    }));
  }

  async countQueryEvents(
    ctx: ReadContext,
    query: { readonly since: Date; readonly byActor: boolean },
  ): Promise<number> {
    // Telemetry count for the spend guard: tenant-scoped, optionally actor-
    // scoped, occurred_at >= since. No access-tag filter (no content), so not
    // bypass-logged — mirrors findRecentQueryEvents.
    const filters: SQL[] = [
      eq(queryEvents.tenantId, ctx.tenantId),
      gte(queryEvents.occurredAt, query.since),
    ];
    if (query.byActor) filters.push(eq(queryEvents.actor, ctx.actor));
    const [row] = await this.db
      .select({ n: count() })
      .from(queryEvents)
      .where(and(...filters));
    return row?.n ?? 0;
  }

  async listAuditEvents(
    ctx: ReadContext,
    query?: { readonly since?: Date; readonly limit?: number },
  ): Promise<readonly AuditEventRecord[]> {
    // Accountability read: tenant-scoped, newest first. audit_events has NO
    // access_tags column (it records access, it is not access-gated content), so
    // — like findRecentQueryEvents — there is no access filter to apply and the
    // read is intentionally NOT wrapped in withBypassLogging. Authorising WHO may
    // view the audit trail is the layer-above's job.
    const filters: SQL[] = [eq(auditEvents.tenantId, ctx.tenantId)];
    if (query?.since) filters.push(gte(auditEvents.occurredAt, query.since));
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(...filters))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(query?.limit ?? DEFAULT_LIMIT);
    return rows.map((r) => ({
      actor: asActorId(r.actor),
      action: r.action,
      targetKind: r.targetKind,
      targetId: r.targetId,
      accessTagsUsed: r.accessTagsUsed,
      // `details` is deliberately NOT projected — see AuditEventRecord: it is an
      // open jsonb bag that can carry identifiers, so content-freedom is made
      // structural here rather than left to every writer's discipline.
      occurredAt: r.occurredAt,
    }));
  }

  async listLlmCalls(
    ctx: ReadContext,
    query?: {
      readonly since?: Date;
      readonly limit?: number;
      readonly purpose?: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
    },
  ): Promise<readonly LlmCallRecord[]> {
    // Cost/egress activity read: tenant-scoped, newest first. llm_calls has no
    // access_tags (or actor) column — it is content-free cost telemetry — so the
    // read is tenant-scoped only and not bypass-wrapped, mirroring the query_event
    // telemetry reads.
    const filters: SQL[] = [eq(llmCalls.tenantId, ctx.tenantId)];
    if (query?.since) filters.push(gte(llmCalls.occurredAt, query.since));
    if (query?.purpose) filters.push(eq(llmCalls.purpose, query.purpose));
    const rows = await this.db
      .select()
      .from(llmCalls)
      .where(and(...filters))
      .orderBy(desc(llmCalls.occurredAt))
      .limit(query?.limit ?? DEFAULT_LIMIT);
    return rows.map((r) => ({
      purpose: r.purpose,
      modelId: r.modelId,
      region: r.region,
      location: classifyRegion(r.region),
      inputTokens: r.inputTokens,
      cachedInputTokens: r.cachedInputTokens,
      outputTokens: r.outputTokens,
      costEstimatePence: r.costEstimatePence === null ? null : Number(r.costEstimatePence),
      latencyMs: r.latencyMs,
      documentId: r.documentId,
      occurredAt: r.occurredAt,
    }));
  }

  async summariseLlmCalls(
    ctx: ReadContext,
    query?: { readonly since?: Date },
  ): Promise<LlmEgressSummary> {
    // Tenant-scoped region/egress rollup (NOT the operator-facing, cross-tenant
    // generateResidencyReport). One grouped query over llm_calls by region; the
    // engine classifies each region into on-device / cloud / stub from its own
    // provider tags. Tenant-scoped only — no access/actor columns to filter on.
    const filters: SQL[] = [eq(llmCalls.tenantId, ctx.tenantId)];
    if (query?.since) filters.push(gte(llmCalls.occurredAt, query.since));
    const grouped = await this.db
      .select({
        region: llmCalls.region,
        calls: count(),
        // COALESCE so a region with no cost model contributes 0, not NULL.
        cost: sql<string>`COALESCE(SUM(${llmCalls.costEstimatePence}), 0)::text`,
      })
      .from(llmCalls)
      .where(and(...filters))
      .groupBy(llmCalls.region)
      .orderBy(desc(count()), llmCalls.region);

    const byRegion: LlmRegionUsage[] = grouped.map((r) => ({
      region: r.region,
      location: classifyRegion(r.region),
      calls: Number(r.calls),
      costEstimatePence: Number(r.cost),
    }));

    const bucket: Record<LlmCallLocation, { calls: number; costEstimatePence: number }> = {
      on_device: { calls: 0, costEstimatePence: 0 },
      cloud: { calls: 0, costEstimatePence: 0 },
      stub: { calls: 0, costEstimatePence: 0 },
    };
    let totalCalls = 0;
    let totalCostEstimatePence = 0;
    for (const r of byRegion) {
      bucket[r.location].calls += r.calls;
      bucket[r.location].costEstimatePence += r.costEstimatePence;
      totalCalls += r.calls;
      totalCostEstimatePence += r.costEstimatePence;
    }
    return {
      byRegion,
      onDevice: bucket.on_device,
      cloud: bucket.cloud,
      stub: bucket.stub,
      totalCalls,
      totalCostEstimatePence,
    };
  }

  async searchByVector(
    ctx: ReadContext,
    query: VectorSearchQuery,
  ): Promise<readonly VectorSearchResult[]> {
    return this.withBypassLogging(
      ctx,
      'searchByVector',
      { modelId: query.modelId, k: query.k },
      async (db) => {
        // Embeddings have tenant_id and access_tags but no deleted_at —
        // soft-delete lives on the underlying paragraph. Custom filter chain
        // (rather than readFilters) + LEFT JOIN to paragraphs so soft-deleted
        // paragraphs hide their embeddings without breaking entity embeddings
        // (which will land in a later session).
        const tenantFilter = eq(embeddings.tenantId, ctx.tenantId);
        const modelFilter = eq(embeddings.modelId, query.modelId);
        const baseFilters: SQL[] = [tenantFilter, modelFilter];
        if (ctx.kind === 'regular') {
          if (ctx.accessTags.length === 0) {
            baseFilters.push(sql`FALSE`);
          } else {
            const literal = toPgTextArrayLiteral(ctx.accessTags);
            baseFilters.push(sql`${embeddings.accessTags} && ${literal}::text[]`);
          }
        }
        baseFilters.push(
          sql`(${embeddings.targetKind} <> 'paragraph' OR ${paragraphs.deletedAt} IS NULL)`,
        );

        const alpha = query.expansionAlpha ?? 1.0;
        const candidateLimit = Math.max(query.k, Math.ceil(query.k * alpha));
        const vectorLiteral = `[${query.queryVector.join(',')}]`;

        // F43: raise HNSW `ef_search` to at least the candidate limit (floored at 100)
        // so the ANN index neither under-recalls at scale nor cliffs when the limit
        // exceeds the default 40. `SET LOCAL` is transaction-scoped, so the search runs
        // inside a transaction (a savepoint on the bypass path, which already opened
        // one). `efSearch` is a controlled integer, inlined via sql.raw because `SET`
        // does not accept bind parameters. Generic tuning constant — no vertical concept.
        const efSearch = Math.trunc(Math.max(HNSW_EF_SEARCH_FLOOR, candidateLimit));
        return db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`));
          const rows = await tx
            .select({
              id: embeddings.id,
              targetKind: embeddings.targetKind,
              targetId: embeddings.targetId,
              modelId: embeddings.modelId,
              accessTags: embeddings.accessTags,
              distance: sql<number>`${embeddings.vector} <=> ${vectorLiteral}::vector`,
            })
            .from(embeddings)
            .leftJoin(
              paragraphs,
              and(eq(embeddings.targetKind, 'paragraph'), eq(paragraphs.id, embeddings.targetId)),
            )
            .where(and(...baseFilters))
            .orderBy(sql`${embeddings.vector} <=> ${vectorLiteral}::vector`)
            .limit(candidateLimit);

          return rows.slice(0, query.k).map((row) => ({
            embeddingId: row.id as VectorSearchResult['embeddingId'],
            targetKind: row.targetKind,
            targetId: row.targetId,
            distance: Number(row.distance),
            accessTags: row.accessTags,
          }));
        });
      },
    );
  }

  async getEmbeddingsByTargets(
    ctx: ReadContext,
    query: {
      readonly targetKind: 'paragraph' | 'entity';
      readonly targetIds: readonly string[];
      readonly modelId: string;
    },
  ): Promise<readonly Embedding[]> {
    if (query.targetIds.length === 0) return [];
    return this.withBypassLogging(
      ctx,
      'getEmbeddingsByTargets',
      { targetKind: query.targetKind, count: query.targetIds.length },
      async (db) => {
        // Same access posture as searchByVector: tenant + model + targetKind +
        // the access-tag overlap (FALSE for an empty caller tag set; skipped
        // under bypass) + soft-delete exclusion via the underlying paragraph.
        // Embeddings carry their own access_tags but no deleted_at (soft-delete
        // lives on the paragraph), so we LEFT JOIN like searchByVector does.
        const filters: SQL[] = [
          eq(embeddings.tenantId, ctx.tenantId),
          eq(embeddings.modelId, query.modelId),
          eq(embeddings.targetKind, query.targetKind),
          inArray(embeddings.targetId, [...query.targetIds]),
          sql`(${embeddings.targetKind} <> 'paragraph' OR ${paragraphs.deletedAt} IS NULL)`,
        ];
        if (ctx.kind === 'regular') {
          if (ctx.accessTags.length === 0) {
            filters.push(sql`FALSE`);
          } else {
            const literal = toPgTextArrayLiteral(ctx.accessTags);
            filters.push(sql`${embeddings.accessTags} && ${literal}::text[]`);
          }
        }
        const rows = await db
          .select({
            id: embeddings.id,
            tenantId: embeddings.tenantId,
            targetKind: embeddings.targetKind,
            targetId: embeddings.targetId,
            modelId: embeddings.modelId,
            vector: embeddings.vector,
            accessTags: embeddings.accessTags,
            createdAt: embeddings.createdAt,
          })
          .from(embeddings)
          .leftJoin(
            paragraphs,
            and(eq(embeddings.targetKind, 'paragraph'), eq(paragraphs.id, embeddings.targetId)),
          )
          .where(and(...filters));
        return rows.map(embeddingFromRow);
      },
    );
  }

  async searchByKeyword(
    ctx: ReadContext,
    query: KeywordSearchQuery,
  ): Promise<readonly KeywordSearchResult[]> {
    // Empty / whitespace query → nothing to match. Short-circuit before hitting
    // the DB (plainto_tsquery of an empty string is the empty query anyway).
    if (query.query.trim() === '') return [];
    return this.withBypassLogging(ctx, 'searchByKeyword', { k: query.k }, async (db) => {
      // SAME read filter as every paragraph read: tenant + soft-delete +
      // access-tag overlap (or FALSE for an empty caller tag set). The keyword
      // path is not a permission bypass — it is access-filtered identically to
      // searchByVector/getParagraphsByIds.
      const filters = this.readFilters(ctx, paragraphs);
      // Postgres full-text search over the paragraph text. `plainto_tsquery`
      // parses the user terms safely (it is a bind param — no injection) and
      // normalises them into stemmed lexemes; `ts_rank_cd` scores cover-density
      // relevance (higher = better). The 'english' text-search config is a
      // LANGUAGE choice, not a vertical one. (A GIN expression index on
      // to_tsvector is a deferred perf follow-up — an internal note; recall is
      // identical with or without it.)
      //
      // ANY-term (OR), not ALL-term (AND): plainto_tsquery joins the parsed
      // lexemes with `&`, so a natural-language question ("what was the outcome
      // of the design review for the Apollo project?") only matches a paragraph
      // that contains EVERY salient word — which a single paragraph almost never
      // does, so the lexical half silently returns nothing for full sentences.
      // We flip the implicit `&` to `|` on the already-parsed query so
      // a paragraph sharing ANY salient term matches, and ts_rank_cd then ranks
      // the most term-dense (and proper-noun / exact-term bearing) paragraphs
      // first. The flip operates on plainto_tsquery's sanitised lexeme output
      // (cast to text and back), so it adds no injection surface. This is the
      // lexical backstop that makes literal names/codes recoverable even when the
      // semantic vector ranks them poorly — vertical-agnostic.
      const tsquery = sql`replace(plainto_tsquery('english', ${query.query})::text, '&', '|')::tsquery`;
      const tsvector = sql`to_tsvector('english', ${paragraphs.text})`;
      filters.push(sql`${tsvector} @@ ${tsquery}`);
      const rank = sql<number>`ts_rank_cd(${tsvector}, ${tsquery})`;

      const rows = await db
        .select({
          targetId: paragraphs.id,
          accessTags: paragraphs.accessTags,
          rank,
        })
        .from(paragraphs)
        .where(and(...filters))
        .orderBy(desc(rank))
        .limit(query.k);

      return rows.map((row) => ({
        targetKind: 'paragraph' as const,
        targetId: row.targetId,
        rank: Number(row.rank),
        accessTags: row.accessTags,
      }));
    });
  }

  async countCitationsByParagraph(
    ctx: ReadContext,
    paragraphIds: readonly ParagraphId[],
  ): Promise<ReadonlyMap<ParagraphId, number>> {
    if (paragraphIds.length === 0) return new Map();
    return this.withBypassLogging(
      ctx,
      'countCitationsByParagraph',
      { count: paragraphIds.length },
      async (db) => {
        // JOIN to paragraphs and apply the SAME read filter as every read
        // (tenant + soft-delete + access-tag overlap) so a count is returned ONLY
        // for a paragraph the caller can see — passing an unseen id yields no row.
        const filters = this.readFilters(ctx, paragraphs);
        filters.push(eq(citationEvents.tenantId, ctx.tenantId));
        filters.push(inArray(citationEvents.paragraphId, [...paragraphIds]));
        const rows = await db
          .select({ paragraphId: citationEvents.paragraphId, n: count() })
          .from(citationEvents)
          .innerJoin(paragraphs, eq(paragraphs.id, citationEvents.paragraphId))
          .where(and(...filters))
          .groupBy(citationEvents.paragraphId);
        const out = new Map<ParagraphId, number>();
        for (const row of rows) out.set(row.paragraphId as ParagraphId, Number(row.n));
        return out;
      },
    );
  }

  async countCitationsByDocument(
    ctx: ReadContext,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, number>> {
    if (documentIds.length === 0) return new Map();
    return this.withBypassLogging(
      ctx,
      'countCitationsByDocument',
      { count: documentIds.length },
      async (db) => {
        // JOIN to documents and apply the SAME read filter as every read (tenant +
        // soft-delete + access-tag overlap) so a count is returned ONLY for a
        // document the caller can see — passing an unseen id yields no row.
        const filters = this.readFilters(ctx, documents);
        filters.push(eq(citationEvents.tenantId, ctx.tenantId));
        filters.push(inArray(citationEvents.documentId, [...documentIds]));
        const rows = await db
          .select({ documentId: citationEvents.documentId, n: count() })
          .from(citationEvents)
          .innerJoin(documents, eq(documents.id, citationEvents.documentId))
          .where(and(...filters))
          .groupBy(citationEvents.documentId);
        const out = new Map<DocumentId, number>();
        for (const row of rows) out.set(row.documentId as DocumentId, Number(row.n));
        return out;
      },
    );
  }

  async findExtractorVersion(
    ctx: ReadContext,
    key: ExtractorVersionNaturalKey,
  ): Promise<ExtractorVersion | null> {
    // No access_tags on extractor_versions — tenant-scoped operational data.
    return this.withBypassLogging(ctx, 'findExtractorVersion', { key }, async (db) => {
      const rows = await db
        .select()
        .from(extractorVersions)
        .where(
          and(
            eq(extractorVersions.tenantId, ctx.tenantId),
            eq(extractorVersions.configurationId, key.configurationId),
            eq(extractorVersions.schemaHash, key.schemaHash),
            eq(extractorVersions.promptHash, key.promptHash),
            eq(extractorVersions.modelId, key.modelId),
          ),
        )
        .limit(1);
      return rows[0] ? extractorVersionFromRow(rows[0]) : null;
    });
  }

  // Review queue (P6a). ACCESS-GATED reads: a single item by id, and the pending
  // list. Both apply the SAME access-tag overlap (&&) as every content read via
  // accessTagOverlapClause — a steward sees only items whose target they may see.
  async getReviewItem(ctx: ReadContext, id: ReviewItemId): Promise<ReviewItem | null> {
    return this.withBypassLogging(ctx, 'getReviewItem', { id }, async (db) => {
      const filters: SQL[] = [eq(reviewQueue.tenantId, ctx.tenantId), eq(reviewQueue.id, id)];
      const access = this.accessTagOverlapClause(ctx, reviewQueue.accessTags);
      if (access) filters.push(access);
      const rows = await db
        .select()
        .from(reviewQueue)
        .where(and(...filters))
        .limit(1);
      return rows[0] ? reviewItemFromRow(rows[0]) : null;
    });
  }

  async findPendingReviewItems(
    ctx: ReadContext,
    query: ReviewQueueQuery = {},
  ): Promise<readonly ReviewItem[]> {
    return this.withBypassLogging(ctx, 'findPendingReviewItems', {}, async (db) => {
      const filters: SQL[] = [
        eq(reviewQueue.tenantId, ctx.tenantId),
        eq(reviewQueue.status, 'pending'),
      ];
      const access = this.accessTagOverlapClause(ctx, reviewQueue.accessTags);
      if (access) filters.push(access);
      const rows = await db
        .select()
        .from(reviewQueue)
        .where(and(...filters))
        .orderBy(reviewQueue.createdAt)
        .limit(query.limit ?? DEFAULT_LIMIT);
      return rows.map(reviewItemFromRow);
    });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async insertEntity(ctx: WriteContext, params: NewEntity): Promise<Entity> {
    this.checkProvenance(params.provenance);
    const id = params.id ?? newEntityId();
    const cols = provenanceToColumns(params.provenance);
    const rows = await this.db
      .insert(entities)
      .values({
        id,
        tenantId: ctx.tenantId,
        type: params.type,
        properties: params.properties as Record<string, unknown>,
        accessTags: [...params.accessTags],
        sourceKind: cols.source_kind,
        sourceDocumentId: cols.source_document_id,
        sourceParagraphId: cols.source_paragraph_id,
        extractorVersionId: cols.extractor_version_id,
        sourceConnectorPackage: cols.source_connector_package,
        confidence: cols.confidence,
        createdBy: ctx.actor,
      })
      .returning();
    if (!rows[0]) throw new GraphStoreError('insertEntity returned no row');
    return entityFromRow(rows[0]);
  }

  async insertEntitiesBulk(
    ctx: WriteContext,
    params: readonly NewEntity[],
  ): Promise<readonly Entity[]> {
    if (params.length === 0) return [];
    for (const p of params) this.checkProvenance(p.provenance);
    const rows = await this.db
      .insert(entities)
      .values(
        params.map((p) => {
          const cols = provenanceToColumns(p.provenance);
          return {
            id: p.id ?? newEntityId(),
            tenantId: ctx.tenantId,
            type: p.type,
            properties: p.properties as Record<string, unknown>,
            accessTags: [...p.accessTags],
            sourceKind: cols.source_kind,
            sourceDocumentId: cols.source_document_id,
            sourceParagraphId: cols.source_paragraph_id,
            extractorVersionId: cols.extractor_version_id,
            sourceConnectorPackage: cols.source_connector_package,
            confidence: cols.confidence,
            createdBy: ctx.actor,
          };
        }),
      )
      .returning();
    return rows.map(entityFromRow);
  }

  async updateEntity(ctx: WriteContext, id: EntityId, patch: EntityPatch): Promise<Entity> {
    const changedFields = changedPatchFields(patch);
    // Mutation + audit row in ONE transaction (mirrors internal_bypass_log): a
    // rolled-back mutation writes no audit row. When called inside a
    // withTransaction (e.g. a steward approval), this.db is already the tx handle
    // so this opens a savepoint — still atomic with the outer transaction.
    return this.db.transaction(async (tx) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.properties !== undefined) updates.properties = patch.properties;
      if (patch.accessTags !== undefined) updates.accessTags = [...patch.accessTags];
      if (patch.confidence !== undefined) updates.confidence = patch.confidence;
      const rows = await tx
        .update(entities)
        .set(updates)
        .where(
          and(eq(entities.tenantId, ctx.tenantId), eq(entities.id, id), isNull(entities.deletedAt)),
        )
        .returning();
      if (!rows[0]) throw new NotFoundError('entity', id);
      const entity = entityFromRow(rows[0]);
      await this.writeAuditEvent(tx, ctx, {
        action: 'update_entity',
        targetKind: 'entity',
        targetId: id,
        accessTagsUsed: entity.accessTags,
        details: { changedFields },
      });
      return entity;
    });
  }

  async softDeleteEntity(ctx: WriteContext, id: EntityId): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(entities)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(eq(entities.tenantId, ctx.tenantId), eq(entities.id, id), isNull(entities.deletedAt)),
        );
      await tx
        .update(edges)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(edges.tenantId, ctx.tenantId),
            or(eq(edges.fromEntityId, id), eq(edges.toEntityId, id)),
            isNull(edges.deletedAt),
          ),
        );
    });
  }

  async softDeleteExtractionsBySchema(
    ctx: WriteContext,
    opts: { readonly keepSchemaHash: string },
  ): Promise<{ readonly entitiesDeleted: number; readonly edgesDeleted: number }> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      // Stale extractor versions for this tenant: any schema hash but the one
      // we are keeping. Used as a subquery so we never materialise the id list.
      const staleVersions = tx
        .select({ id: extractorVersions.id })
        .from(extractorVersions)
        .where(
          and(
            eq(extractorVersions.tenantId, ctx.tenantId),
            ne(extractorVersions.schemaHash, opts.keepSchemaHash),
          ),
        );

      // 1. Soft-delete entities produced under a stale schema.
      const deletedEntities = await tx
        .update(entities)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(entities.tenantId, ctx.tenantId),
            isNull(entities.deletedAt),
            inArray(entities.extractorVersionId, staleVersions),
          ),
        )
        .returning({ id: entities.id });

      // 2. Cascade to edges incident to those entities (mirrors softDeleteEntity).
      let cascadeEdgeCount = 0;
      if (deletedEntities.length > 0) {
        const ids = deletedEntities.map((r) => r.id as EntityId);
        const cascaded = await tx
          .update(edges)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(edges.tenantId, ctx.tenantId),
              isNull(edges.deletedAt),
              or(inArray(edges.fromEntityId, ids), inArray(edges.toEntityId, ids)),
            ),
          )
          .returning({ id: edges.id });
        cascadeEdgeCount = cascaded.length;
      }

      // 3. Soft-delete stale-schema edges not already removed by the cascade.
      const deletedEdges = await tx
        .update(edges)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(edges.tenantId, ctx.tenantId),
            isNull(edges.deletedAt),
            inArray(edges.extractorVersionId, staleVersions),
          ),
        )
        .returning({ id: edges.id });

      // edgesDeleted = edges removed by the entity cascade (any schema, dangling
      // because an endpoint was just deleted) + edges with their own stale
      // schema. The two sets are disjoint (step 3 excludes already-deleted rows).
      return {
        entitiesDeleted: deletedEntities.length,
        edgesDeleted: cascadeEdgeCount + deletedEdges.length,
      };
    });
  }

  async insertEdge(ctx: WriteContext, params: NewEdge): Promise<Edge> {
    this.checkProvenance(params.provenance);
    const id = params.id ?? newEdgeId();
    const cols = provenanceToColumns(params.provenance);
    const rows = await this.db
      .insert(edges)
      .values({
        id,
        tenantId: ctx.tenantId,
        type: params.type,
        fromEntityId: params.fromEntityId,
        toEntityId: params.toEntityId,
        properties: (params.properties ?? {}) as Record<string, unknown>,
        accessTags: [...params.accessTags],
        sourceKind: cols.source_kind,
        sourceDocumentId: cols.source_document_id,
        sourceParagraphId: cols.source_paragraph_id,
        extractorVersionId: cols.extractor_version_id,
        sourceConnectorPackage: cols.source_connector_package,
        confidence: cols.confidence,
        createdBy: ctx.actor,
      })
      .returning();
    if (!rows[0]) throw new GraphStoreError('insertEdge returned no row');
    return edgeFromRow(rows[0]);
  }

  async insertEdgesBulk(ctx: WriteContext, params: readonly NewEdge[]): Promise<readonly Edge[]> {
    if (params.length === 0) return [];
    for (const p of params) this.checkProvenance(p.provenance);
    const rows = await this.db
      .insert(edges)
      .values(
        params.map((p) => {
          const cols = provenanceToColumns(p.provenance);
          return {
            id: p.id ?? newEdgeId(),
            tenantId: ctx.tenantId,
            type: p.type,
            fromEntityId: p.fromEntityId,
            toEntityId: p.toEntityId,
            properties: (p.properties ?? {}) as Record<string, unknown>,
            accessTags: [...p.accessTags],
            sourceKind: cols.source_kind,
            sourceDocumentId: cols.source_document_id,
            sourceParagraphId: cols.source_paragraph_id,
            extractorVersionId: cols.extractor_version_id,
            sourceConnectorPackage: cols.source_connector_package,
            confidence: cols.confidence,
            createdBy: ctx.actor,
          };
        }),
      )
      .returning();
    return rows.map(edgeFromRow);
  }

  async updateEdge(ctx: WriteContext, id: EdgeId, patch: EdgePatch): Promise<Edge> {
    const changedFields = changedPatchFields(patch);
    // Mutation + audit row in ONE transaction — see updateEntity.
    return this.db.transaction(async (tx) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.properties !== undefined) updates.properties = patch.properties;
      if (patch.accessTags !== undefined) updates.accessTags = [...patch.accessTags];
      if (patch.confidence !== undefined) updates.confidence = patch.confidence;
      const rows = await tx
        .update(edges)
        .set(updates)
        .where(and(eq(edges.tenantId, ctx.tenantId), eq(edges.id, id), isNull(edges.deletedAt)))
        .returning();
      if (!rows[0]) throw new NotFoundError('edge', id);
      const edge = edgeFromRow(rows[0]);
      await this.writeAuditEvent(tx, ctx, {
        action: 'update_edge',
        targetKind: 'edge',
        targetId: id,
        accessTagsUsed: edge.accessTags,
        details: { changedFields },
      });
      return edge;
    });
  }

  async softDeleteEdge(ctx: WriteContext, id: EdgeId): Promise<void> {
    const now = new Date();
    await this.db
      .update(edges)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(edges.tenantId, ctx.tenantId), eq(edges.id, id), isNull(edges.deletedAt)));
  }

  async insertDocument(ctx: WriteContext, params: NewDocument): Promise<Document> {
    const id = params.id ?? newDocumentId();
    const rows = await this.db
      .insert(documents)
      .values({
        id,
        tenantId: ctx.tenantId,
        externalId: params.externalId ?? null,
        connectorPackage: params.connectorPackage ?? null,
        title: params.title,
        mimeType: params.mimeType ?? null,
        byteSize: params.byteSize ?? null,
        sha256: params.sha256 ?? null,
        blobStorageUri: params.blobStorageUri,
        sourceModifiedAt: params.sourceModifiedAt ?? null,
        simhash: params.simhash ?? null,
        versionGroupId: params.versionGroupId ?? null,
        versionSeq: params.versionSeq ?? null,
        supersedesDocumentId: params.supersedesDocumentId ?? null,
        validFrom: params.validFrom ?? null,
        sensitivityClassId: params.sensitivityClassId ?? null,
        accessTags: [...params.accessTags],
        createdBy: ctx.actor,
      })
      .returning();
    if (!rows[0]) throw new GraphStoreError('insertDocument returned no row');
    return documentFromRow(rows[0]);
  }

  // Mark a prior document version superseded by stamping `valid_to`. The row
  // stays LIVE (not soft-deleted) and remains retrievable; query-time ranking
  // demotes it. Tenant-scoped; only acts on a not-yet-superseded row (idempotent,
  // and never moves an already-set valid_to). `updated_at` records the change.
  async supersedeDocument(
    ctx: WriteContext,
    id: DocumentId,
    opts: { readonly validTo: Date },
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ validTo: opts.validTo, updatedAt: new Date() })
      .where(
        and(
          eq(documents.tenantId, ctx.tenantId),
          eq(documents.id, id),
          isNull(documents.validTo),
          isNull(documents.deletedAt),
        ),
      );
  }

  // Record a near/semantic duplicate LINK. Idempotent on the natural key so a
  // re-run of detection records each link once. Never a merge: both endpoint
  // documents are untouched.
  async recordDocumentDuplicate(ctx: WriteContext, params: NewDocumentDuplicate): Promise<void> {
    await this.db
      .insert(documentDuplicates)
      .values({
        id: crypto.randomUUID(),
        tenantId: ctx.tenantId,
        documentId: params.documentId,
        duplicateOfDocumentId: params.duplicateOfDocumentId,
        method: params.method,
        score: params.score,
      })
      .onConflictDoNothing();
  }

  async insertParagraphsBulk(
    ctx: WriteContext,
    params: readonly NewParagraph[],
  ): Promise<readonly Paragraph[]> {
    if (params.length === 0) return [];
    const rows = await this.db
      .insert(paragraphs)
      .values(
        params.map((p) => ({
          id: p.id ?? newParagraphId(),
          tenantId: ctx.tenantId,
          documentId: p.documentId,
          paragraphIndex: p.paragraphIndex,
          page: p.page ?? null,
          text: p.text,
          structure: (p.structure ?? {}) as Record<string, unknown>,
          accessTags: [...p.accessTags],
          createdBy: ctx.actor,
        })),
      )
      .returning();
    return rows.map(paragraphFromRow);
  }

  async softDeleteDocument(ctx: WriteContext, id: DocumentId): Promise<void> {
    const now = new Date();
    await this.db
      .update(documents)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(documents.tenantId, ctx.tenantId),
          eq(documents.id, id),
          isNull(documents.deletedAt),
        ),
      );
  }

  async hardDeleteDocument(ctx: WriteContext, id: DocumentId): Promise<HardDeleteReceipt> {
    // Erasure deliberately crosses access tags — it must remove EVERY row derived
    // from the document regardless of how each is tagged. That access-filter
    // bypass is recorded in internal_bypass_log; tenant isolation is NEVER
    // dropped (every statement below is tenant-scoped).
    const bypass = internalBypass(
      'graph.hard-delete',
      'GDPR right-to-erasure: remove every row + blob derived from a document, plus pending review suggestions targeting the erased rows, across all access tags',
    );
    const occurredAt = new Date();
    return this.db.transaction(async (tx) => {
      // 0. The document must exist in this tenant; capture its blob URI before we
      //    delete the row (the orchestrator erases the blob after we commit).
      const docRows = await tx
        .select({ blobStorageUri: documents.blobStorageUri })
        .from(documents)
        .where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.id, id)))
        .limit(1);
      if (!docRows[0]) throw new NotFoundError('document', id);
      const blobUri = docRows[0].blobStorageUri;

      // 1. Resolve the doc's paragraph ids + the entity ids extracted from it.
      const paraRows = await tx
        .select({ id: paragraphs.id })
        .from(paragraphs)
        .where(and(eq(paragraphs.tenantId, ctx.tenantId), eq(paragraphs.documentId, id)));
      const entityRows = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.tenantId, ctx.tenantId), eq(entities.sourceDocumentId, id)));
      const paragraphIds = paraRows.map((r) => r.id);
      const entityIds = entityRows.map((r) => r.id);

      // 1b. Resolve EVERY edge id that will vanish — the provenance edges
      //     (source_document_id = id, deleted in step 3) PLUS edges incident to
      //     the doc's entities (cascade-deleted by step 4). Collected BEFORE the
      //     deletes because the review-queue sweep (step 6b) must match pending
      //     items pointing at rows that no longer exist afterwards.
      const edgeIdSet = new Set<string>();
      const provEdgeRows = await tx
        .select({ id: edges.id })
        .from(edges)
        .where(and(eq(edges.tenantId, ctx.tenantId), eq(edges.sourceDocumentId, id)));
      for (const r of provEdgeRows) edgeIdSet.add(r.id);
      if (entityIds.length > 0) {
        const incidentRows = await tx
          .select({ id: edges.id })
          .from(edges)
          .where(
            and(
              eq(edges.tenantId, ctx.tenantId),
              or(inArray(edges.fromEntityId, entityIds), inArray(edges.toEntityId, entityIds)),
            ),
          );
        for (const r of incidentRows) edgeIdSet.add(r.id);
      }
      const edgeIds = [...edgeIdSet];

      // 2. Embeddings are polymorphic (target_kind, target_id) with NO FK — delete
      //    BOTH the paragraph vectors and the entity vectors explicitly, or they
      //    are never erased (no cascade can reach them).
      let embeddingsDeleted = 0;
      if (paragraphIds.length > 0) {
        const removed = await tx
          .delete(embeddings)
          .where(
            and(
              eq(embeddings.tenantId, ctx.tenantId),
              eq(embeddings.targetKind, 'paragraph'),
              inArray(embeddings.targetId, paragraphIds),
            ),
          )
          .returning({ id: embeddings.id });
        embeddingsDeleted += removed.length;
      }
      if (entityIds.length > 0) {
        const removed = await tx
          .delete(embeddings)
          .where(
            and(
              eq(embeddings.tenantId, ctx.tenantId),
              eq(embeddings.targetKind, 'entity'),
              inArray(embeddings.targetId, entityIds),
            ),
          )
          .returning({ id: embeddings.id });
        embeddingsDeleted += removed.length;
      }

      // 3. Edges with source_document_id = id. Their FK is ON DELETE SET NULL, so
      //    a naive document delete would ORPHAN them content-intact — delete them.
      const edgesDeleted = (
        await tx
          .delete(edges)
          .where(and(eq(edges.tenantId, ctx.tenantId), eq(edges.sourceDocumentId, id)))
          .returning({ id: edges.id })
      ).length;

      // 4. Entities with source_document_id = id (same SET NULL reasoning).
      //    Deleting these cascades any remaining incident edges (from/to_entity_id
      //    are ON DELETE CASCADE), so with step 3 every edge from the doc is gone.
      const entitiesDeleted = (
        await tx
          .delete(entities)
          .where(and(eq(entities.tenantId, ctx.tenantId), eq(entities.sourceDocumentId, id)))
          .returning({ id: entities.id })
      ).length;

      // 5. Count the rows the document delete will CASCADE away (citation_events,
      //    document_duplicates) before they vanish, for the content-free receipt.
      const citeCount = await tx
        .select({ value: count() })
        .from(citationEvents)
        .where(and(eq(citationEvents.tenantId, ctx.tenantId), eq(citationEvents.documentId, id)));
      const dupCount = await tx
        .select({ value: count() })
        .from(documentDuplicates)
        .where(
          and(
            eq(documentDuplicates.tenantId, ctx.tenantId),
            or(
              eq(documentDuplicates.documentId, id),
              eq(documentDuplicates.duplicateOfDocumentId, id),
            ),
          ),
        );

      // 6. Delete the document row → cascades paragraphs, citation_events,
      //    document_duplicates (all ON DELETE CASCADE).
      await tx
        .delete(documents)
        .where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.id, id)));

      // 6b. Sweep PENDING review items whose target was just erased (F54): a
      //     stale pending item still carries its proposed_change payload for a
      //     row that no longer exists and could otherwise be approved after
      //     erasure. PENDING only — resolved items are the decision trail
      //     (their payloads age out via the resolved-item retention scrub).
      //     Covers the graph-row target kinds ('entity'/'edge') — a NEW review
      //     targetKind that can reference document-derived rows must extend
      //     this sweep. A suggestion committed AFTER this transaction can
      //     still orphan-point at the erased rows (no FK on the polymorphic
      //     target_id); it stays access-gated + pending until a steward
      //     rejects it.
      const reviewItemsDeleted =
        (await this.deletePendingReviewItemsOn(tx, ctx.tenantId, 'entity', entityIds)) +
        (await this.deletePendingReviewItemsOn(tx, ctx.tenantId, 'edge', edgeIds));

      const deletedCounts: DocumentErasureCounts = {
        embeddings: embeddingsDeleted,
        entities: entitiesDeleted,
        edges: edgesDeleted,
        paragraphs: paragraphIds.length,
        citationEvents: Number(citeCount[0]?.value ?? 0),
        duplicates: Number(dupCount[0]?.value ?? 0),
        reviewItems: reviewItemsDeleted,
      };

      // 7. Record the deliberate access-filter bypass (this op crossed tags).
      await tx.insert(internalBypassLog).values({
        id: crypto.randomUUID(),
        tenantId: ctx.tenantId,
        callSite: bypass.callSite,
        reason: bypass.reason,
        details: { operation: 'hardDeleteDocument', documentId: id },
      });

      // 8. The in-transaction audit row — content-free counts only, never content.
      await this.writeAuditEvent(tx, ctx, {
        action: 'hard_delete_document',
        targetKind: 'document',
        targetId: id,
        accessTagsUsed: [],
        details: { deletedCounts },
      });

      return {
        documentId: id,
        tenantId: ctx.tenantId,
        blobUri,
        deletedCounts,
        occurredAt,
        actor: ctx.actor,
      };
    });
  }

  async recordIncompleteErasure(
    ctx: WriteContext,
    params: { readonly documentId: DocumentId; readonly reason: string },
  ): Promise<void> {
    // A post-commit follow-up audit row: the document's ROWS are already erased,
    // but the blob was not confirmed gone — flag it for retry in the trail. The
    // reason is a storage-layer error string (a path/status), never content.
    await this.writeAuditEvent(this.db, ctx, {
      action: 'hard_delete_document_incomplete',
      targetKind: 'document',
      targetId: params.documentId,
      accessTagsUsed: [],
      details: { blobErased: false, reason: params.reason },
    });
  }

  async recordAuditEvent(ctx: WriteContext, params: AuditEventInput): Promise<void> {
    // Generic public wrapper over the same private writer updateEntity/updateEdge
    // use. `this.db` is the tx handle when called inside a withTransaction / shared
    // tx, so the row commits or rolls back with the action it records.
    await this.writeAuditEvent(this.db, ctx, {
      action: params.action,
      targetKind: params.targetKind,
      targetId: params.targetId,
      accessTagsUsed: params.accessTagsUsed,
      // reason: strips Readonly for the writer's mutable jsonb param; opaque either way.
      details: { ...params.details },
    });
  }

  async upsertExtractorVersion(
    ctx: WriteContext,
    params: NewExtractorVersion,
  ): Promise<ExtractorVersion> {
    const id = params.id ?? newExtractorVersionId();
    const inserted = await this.db
      .insert(extractorVersions)
      .values({
        id,
        tenantId: ctx.tenantId,
        configurationId: params.configurationId,
        configurationVersion: params.configurationVersion,
        schemaHash: params.schemaHash,
        promptHash: params.promptHash,
        modelId: params.modelId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return extractorVersionFromRow(inserted[0]);

    // Conflict — fetch the existing row by natural key (within tenant).
    const existing = await this.db
      .select()
      .from(extractorVersions)
      .where(
        and(
          eq(extractorVersions.tenantId, ctx.tenantId),
          eq(extractorVersions.configurationId, params.configurationId),
          eq(extractorVersions.schemaHash, params.schemaHash),
          eq(extractorVersions.promptHash, params.promptHash),
          eq(extractorVersions.modelId, params.modelId),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      throw new CrossTenantWriteError(
        'upsertExtractorVersion reported conflict but no matching row in tenant — cross-tenant collision suspected',
      );
    }
    return extractorVersionFromRow(existing[0]);
  }

  async upsertEmbedding(ctx: WriteContext, params: NewEmbedding): Promise<Embedding> {
    if (params.vector.length === 0) {
      throw new GraphStoreError('upsertEmbedding requires a non-empty vector');
    }
    const id = params.id ?? newEmbeddingId();

    // Use ON CONFLICT on the natural key (tenant, target_kind, target_id, model)
    // to make the operation idempotent. A trigger added in migration 0001
    // copies access_tags from the paragraph if the insert omits them.
    const inserted = await this.db
      .insert(embeddings)
      .values({
        id,
        tenantId: ctx.tenantId,
        targetKind: params.targetKind,
        targetId: params.targetId,
        modelId: params.modelId,
        vector: [...params.vector],
        ...(params.accessTags !== undefined ? { accessTags: [...params.accessTags] } : {}),
      })
      .onConflictDoUpdate({
        target: [
          embeddings.tenantId,
          embeddings.targetKind,
          embeddings.targetId,
          embeddings.modelId,
        ],
        set: {
          vector: [...params.vector],
          ...(params.accessTags !== undefined ? { accessTags: [...params.accessTags] } : {}),
        },
      })
      .returning();

    if (!inserted[0]) {
      throw new GraphStoreError('upsertEmbedding returned no row');
    }
    return embeddingFromRow(inserted[0]);
  }

  async insertLlmCall(ctx: WriteContext, params: NewLlmCall): Promise<void> {
    await this.db.insert(llmCalls).values({
      id: crypto.randomUUID(),
      tenantId: ctx.tenantId,
      purpose: params.purpose,
      modelId: params.modelId,
      inputTokens: params.inputTokens,
      cachedInputTokens: params.cachedInputTokens,
      outputTokens: params.outputTokens,
      latencyMs: params.latencyMs,
      region: params.region,
      extractorVersionId: params.extractorVersionId ?? null,
      documentId: params.documentId ?? null,
      metadata: {
        ...(params.metadata ?? {}),
        ...(params.failed ? { failed: true } : {}),
      },
    });
  }

  async insertQueryEvent(ctx: WriteContext, params: NewQueryEvent): Promise<void> {
    await this.db.insert(queryEvents).values({
      tenantId: ctx.tenantId,
      actor: params.actor,
      status: params.status,
      resultCount: params.resultCount,
      latencyMs: params.latencyMs,
    });
  }

  async insertCitationEvents(
    ctx: WriteContext,
    events: readonly CitationEventInput[],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.db.insert(citationEvents).values(
      events.map((e) => ({
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        documentId: e.documentId,
        paragraphId: e.paragraphId,
      })),
    );
  }

  // Review queue (P6a). enqueue records a SUGGESTION (status 'pending', zero
  // shared effect — the golden rule); resolve flips a still-pending item to its
  // terminal state. Neither applies the change: APPLYING an approved correction
  // is updateEntity/updateEdge, audited there.
  async enqueueReviewItem(ctx: WriteContext, params: NewReviewItem): Promise<ReviewItem> {
    const rows = await this.db
      .insert(reviewQueue)
      .values({
        id: params.id ?? newReviewItemId(),
        tenantId: ctx.tenantId,
        targetKind: params.targetKind,
        targetId: params.targetId ?? null,
        // reason: strips Readonly for Drizzle's mutable jsonb param; the value is
        // opaque to the engine either way (stored + returned verbatim).
        proposedChange: params.proposedChange as Record<string, unknown>,
        proposedBy: ctx.actor,
        status: 'pending',
        accessTags: [...params.accessTags],
        note: params.note ?? null,
      })
      .returning();
    if (!rows[0]) throw new GraphStoreError('enqueueReviewItem returned no row');
    return reviewItemFromRow(rows[0]);
  }

  async resolveReviewItem(
    ctx: WriteContext,
    id: ReviewItemId,
    decision: ReviewDecision,
  ): Promise<ReviewItem> {
    const now = new Date();
    const rows = await this.db
      .update(reviewQueue)
      .set({
        status: decision.decision,
        reviewedBy: ctx.actor,
        reviewedAt: now,
        updatedAt: now,
      })
      // Tenant-scoped AND still-pending: re-resolving an already-resolved item
      // matches nothing (→ NotFound), so an approval can never be flipped.
      .where(
        and(
          eq(reviewQueue.tenantId, ctx.tenantId),
          eq(reviewQueue.id, id),
          eq(reviewQueue.status, 'pending'),
        ),
      )
      .returning();
    if (!rows[0]) throw new NotFoundError('reviewItem', id);
    return reviewItemFromRow(rows[0]);
  }

  async deletePendingReviewItemsByTargets(
    ctx: WriteContext,
    targetKind: string,
    targetIds: readonly string[],
  ): Promise<number> {
    return this.deletePendingReviewItemsOn(this.db, ctx.tenantId, targetKind, targetIds);
  }

  // Shared by the public method and hardDeleteDocument's in-tx sweep — ONE
  // place spells the pending-only/tenant-scoped delete.
  private async deletePendingReviewItemsOn(
    db: Db,
    tenantId: TenantId,
    targetKind: string,
    targetIds: readonly string[],
  ): Promise<number> {
    if (targetIds.length === 0) return 0;
    const rows = await db
      .delete(reviewQueue)
      .where(
        and(
          eq(reviewQueue.tenantId, tenantId),
          eq(reviewQueue.status, 'pending'),
          eq(reviewQueue.targetKind, targetKind),
          inArray(reviewQueue.targetId, [...targetIds]),
        ),
      )
      .returning({ id: reviewQueue.id });
    return rows.length;
  }

  async scrubResolvedReviewItems(ctx: WriteContext, cutoff: Date): Promise<number> {
    // Retention scrub (F54): resolved (approved/rejected) items older than the
    // cutoff lose their content-bearing fields — proposed_change → '{}', note →
    // NULL — while status / proposed_by / reviewed_by / timestamps stay as the
    // decision trail. PENDING items are NEVER touched (they age out only by
    // being resolved or erasure-swept — never silently); the status list is an
    // explicit allowlist, NOT `!= 'pending'`, so a future intermediate status
    // fails CLOSED (kept) rather than being silently scrubbed. Idempotent: the
    // content predicate makes an already-scrubbed row unmatchable, so counts
    // stay honest on re-runs. `reviewed_at < cutoff` is NULL-safe (NULL never
    // compares true), giving unresolved rows a second structural shield.
    const rows = await this.db
      .update(reviewQueue)
      .set({
        proposedChange: {},
        note: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(reviewQueue.tenantId, ctx.tenantId),
          inArray(reviewQueue.status, ['approved', 'rejected']),
          lt(reviewQueue.reviewedAt, cutoff),
          sql`(${reviewQueue.proposedChange} != '{}'::jsonb OR ${reviewQueue.note} IS NOT NULL)`,
        ),
      )
      .returning({ id: reviewQueue.id });
    return rows.length;
  }

  async withTransaction<T>(_ctx: WriteContext, fn: (tx: GraphStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => {
      const tx = new PostgresGraphStore(txDb);
      return fn(tx);
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async getEntityRaw(db: Db, ctx: ReadContext, id: EntityId): Promise<Entity | null> {
    const filters = this.readFilters(ctx, entities);
    filters.push(eq(entities.id, id));
    const rows = await db
      .select()
      .from(entities)
      .where(and(...filters))
      .limit(1);
    return rows[0] ? entityFromRow(rows[0]) : null;
  }

  private async getEntitiesByIdsRaw(
    db: Db,
    ctx: ReadContext,
    ids: readonly EntityId[],
  ): Promise<readonly Entity[]> {
    if (ids.length === 0) return [];
    const filters = this.readFilters(ctx, entities);
    filters.push(inArray(entities.id, [...ids]));
    const rows = await db
      .select()
      .from(entities)
      .where(and(...filters));
    return rows.map(entityFromRow);
  }

  // The access-tag overlap clause for a table's `access_tags` column, with the
  // EXACT regular-read semantics: null for a bypass read (no tag filter); FALSE
  // for an empty regular tag set ("sees nothing"); else the `&&` array overlap.
  // Extracted so reads on tables WITHOUT a soft-delete column (e.g. review_queue)
  // reuse the same access logic rather than re-deriving — there is one place the
  // access filter is spelled, used by both readFilters and the queue read.
  private accessTagOverlapClause(ctx: ReadContext, accessTagsColumn: AnyPgColumn): SQL | null {
    if (ctx.kind !== 'regular') return null;
    // Empty caller tag set → caller sees nothing protected. Generate a FALSE
    // clause rather than the overlap check, both because an empty text[] cast can
    // confuse the planner and because this is the literal semantic we want:
    // `accessTags = []` means no visibility.
    if (ctx.accessTags.length === 0) return sql`FALSE`;
    // Postgres `&&` on text[] needs an actual array literal. We serialise the
    // caller's tag set into PG array-literal form so the `::text[]` cast succeeds
    // and the overlap operator does what we want. Caller tags are opaque short
    // strings — colons, slashes, alphanumerics — but we still escape defensively
    // for any element containing characters with special PG-array meaning.
    const literal = toPgTextArrayLiteral(ctx.accessTags);
    return sql`${accessTagsColumn} && ${literal}::text[]`;
  }

  // Common WHERE-clause filters for any domain table read: tenant scoping,
  // soft-delete exclusion, and (for regular reads) access-tag intersection.
  //
  // Drizzle's PgColumn includes the tableName in its type, so a generic
  // signature accepting "any domain table with tenantId/accessTags/deletedAt"
  // is awkward to spell. The runtime expectation is fixed — every domain table
  // this method is called on has those three columns.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above — a generic "any domain table with tenantId/accessTags/deletedAt" signature is impractical to spell against Drizzle's table-name-typed PgColumn; the runtime contract is fixed
  private readFilters(ctx: ReadContext, table: any): SQL[] {
    const out: SQL[] = [eq(table.tenantId, ctx.tenantId), isNull(table.deletedAt)];
    const access = this.accessTagOverlapClause(ctx, table.accessTags);
    if (access) out.push(access);
    return out;
  }

  // Validate provenance shape. The DB CHECK constraint is the authoritative
  // guard, but we raise early with a typed error so callers don't get a raw
  // SQL exception.
  private checkProvenance(p: Provenance): void {
    if (p.kind === 'document_extract') {
      if (!p.paragraphId || !p.extractorVersionId) {
        throw new InvalidProvenanceError(
          'document_extract provenance requires non-null paragraphId and extractorVersionId',
        );
      }
    }
    if ('confidence' in p && p.confidence !== null && p.confidence !== undefined) {
      if (p.confidence < 0 || p.confidence > 1) {
        throw new InvalidProvenanceError('confidence must be between 0 and 1 inclusive');
      }
    }
  }

  private async withBypassLogging<T>(
    ctx: ReadContext,
    operation: string,
    details: Record<string, unknown>,
    fn: (db: Db) => Promise<T>,
  ): Promise<T> {
    if (ctx.kind === 'regular') return fn(this.db);
    return this.db.transaction(async (tx) => {
      await tx.insert(internalBypassLog).values({
        id: crypto.randomUUID(),
        tenantId: ctx.tenantId,
        callSite: ctx.bypass.callSite,
        reason: ctx.bypass.reason,
        details: { operation, ...details },
      });
      return fn(tx);
    });
  }

  // Write ONE audit_events row using the SUPPLIED db handle (mirrors the
  // internal_bypass_log write). The caller passes its transaction handle so the
  // audit row commits/rolls back ATOMICALLY with the mutation it describes — a
  // rolled-back mutation leaves no audit row. `details` must be a small,
  // CONTENT-FREE summary (changed field NAMES) — never values/PII (F4 spirit).
  private async writeAuditEvent(
    db: Db,
    ctx: WriteContext,
    params: {
      readonly action: string;
      readonly targetKind: string;
      readonly targetId: string;
      readonly accessTagsUsed: readonly string[];
      readonly details: Record<string, unknown>;
    },
  ): Promise<void> {
    await db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      action: params.action,
      targetKind: params.targetKind,
      targetId: params.targetId,
      accessTagsUsed: [...params.accessTagsUsed],
      details: params.details,
    });
  }
}

// DB row ↔ domain type mapping.
//
// Kept separate so the adapter implementation reads as data access. The
// provenance discriminated union is constructed and deconstructed here.

import {
  type Document,
  type Edge,
  type Embedding,
  type Entity,
  type ExtractorVersion,
  type Paragraph,
  type Provenance,
  type ReviewItem,
  type ReviewItemStatus,
  asActorId,
  asDocumentId,
  asEdgeId,
  asEmbeddingId,
  asEntityId,
  asExtractorVersionId,
  asParagraphId,
  asReviewItemId,
  asTenantId,
} from './types';

interface ProvenanceColumns {
  readonly source_kind: 'document_extract' | 'connector' | 'manual' | 'system';
  readonly source_document_id: string | null;
  readonly source_paragraph_id: string | null;
  readonly extractor_version_id: string | null;
  readonly source_connector_package: string | null;
  readonly confidence: number | null;
}

interface EntityRow extends ProvenanceColumns {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly properties: unknown;
  readonly access_tags: readonly string[];
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

interface EdgeRow extends ProvenanceColumns {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly from_entity_id: string;
  readonly to_entity_id: string;
  readonly properties: unknown;
  readonly access_tags: readonly string[];
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

interface DocumentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly external_id: string | null;
  readonly connector_package: string | null;
  readonly title: string;
  readonly mime_type: string | null;
  readonly byte_size: bigint | null;
  readonly sha256: string | null;
  readonly blob_storage_uri: string;
  readonly source_modified_at: Date | null;
  readonly version_group_id: string | null;
  readonly version_seq: number | null;
  readonly supersedes_document_id: string | null;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly sensitivity_class_id: string | null;
  readonly access_tags: readonly string[];
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

interface ParagraphRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly document_id: string;
  readonly paragraph_index: number;
  readonly page: number | null;
  readonly text: string;
  readonly structure: unknown;
  readonly access_tags: readonly string[];
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

interface ReviewQueueRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly target_kind: string;
  readonly target_id: string | null;
  readonly proposed_change: unknown;
  readonly proposed_by: string;
  readonly status: string;
  readonly access_tags: readonly string[];
  readonly reviewed_by: string | null;
  readonly reviewed_at: Date | null;
  readonly note: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ExtractorVersionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly configuration_id: string;
  readonly configuration_version: string;
  readonly schema_hash: string;
  readonly prompt_hash: string;
  readonly model_id: string;
  readonly created_at: Date;
}

// Drizzle returns objects with camelCase keys matching the schema definition.
// To keep this mapping module agnostic of Drizzle, we accept either shape via
// the input type below.
type Snake<T extends Record<string, unknown>> = T;
type FromDrizzle<T> = T extends infer R ? { [K in keyof R]: R[K] } : never;

export function provenanceFromRow(row: ProvenanceColumns): Provenance {
  switch (row.source_kind) {
    case 'document_extract':
      if (!row.source_paragraph_id || !row.extractor_version_id) {
        throw new Error(
          'document_extract row missing source_paragraph_id or extractor_version_id (CHECK constraint should have caught this)',
        );
      }
      return {
        kind: 'document_extract',
        documentId: row.source_document_id
          ? asDocumentId(row.source_document_id)
          : asDocumentId(''),
        paragraphId: asParagraphId(row.source_paragraph_id),
        extractorVersionId: asExtractorVersionId(row.extractor_version_id),
        confidence: row.confidence,
      };
    case 'connector':
      return {
        kind: 'connector',
        connectorPackage: row.source_connector_package ?? '',
        documentId: row.source_document_id ? asDocumentId(row.source_document_id) : null,
        confidence: row.confidence,
      };
    case 'manual':
      return { kind: 'manual', confidence: row.confidence };
    case 'system':
      return { kind: 'system' };
  }
}

export function provenanceToColumns(p: Provenance): ProvenanceColumns {
  switch (p.kind) {
    case 'document_extract':
      return {
        source_kind: 'document_extract',
        source_document_id: p.documentId,
        source_paragraph_id: p.paragraphId,
        extractor_version_id: p.extractorVersionId,
        source_connector_package: null,
        confidence: p.confidence,
      };
    case 'connector':
      return {
        source_kind: 'connector',
        source_document_id: p.documentId,
        source_paragraph_id: null,
        extractor_version_id: null,
        source_connector_package: p.connectorPackage,
        confidence: p.confidence,
      };
    case 'manual':
      return {
        source_kind: 'manual',
        source_document_id: null,
        source_paragraph_id: null,
        extractor_version_id: null,
        source_connector_package: null,
        confidence: p.confidence,
      };
    case 'system':
      return {
        source_kind: 'system',
        source_document_id: null,
        source_paragraph_id: null,
        extractor_version_id: null,
        source_connector_package: null,
        confidence: null,
      };
  }
}

// Drizzle returns camelCase keys by default. Convert to the snake_case row
// shape this mapping module uses. Cheap; runs once per row.
function asSnake(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] = v;
  }
  return out;
}

export function entityFromRow(row: Record<string, unknown>): Entity {
  const r = asSnake(row) as unknown as EntityRow;
  return {
    id: asEntityId(r.id),
    tenantId: asTenantId(r.tenant_id),
    type: r.type,
    properties: (r.properties ?? {}) as Readonly<Record<string, unknown>>,
    accessTags: r.access_tags,
    provenance: provenanceFromRow(r),
    createdBy: asActorId(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function edgeFromRow(row: Record<string, unknown>): Edge {
  const r = asSnake(row) as unknown as EdgeRow;
  return {
    id: asEdgeId(r.id),
    tenantId: asTenantId(r.tenant_id),
    type: r.type,
    fromEntityId: asEntityId(r.from_entity_id),
    toEntityId: asEntityId(r.to_entity_id),
    properties: (r.properties ?? {}) as Readonly<Record<string, unknown>>,
    accessTags: r.access_tags,
    provenance: provenanceFromRow(r),
    createdBy: asActorId(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function documentFromRow(row: Record<string, unknown>): Document {
  const r = asSnake(row) as unknown as DocumentRow;
  return {
    id: asDocumentId(r.id),
    tenantId: asTenantId(r.tenant_id),
    externalId: r.external_id,
    connectorPackage: r.connector_package,
    title: r.title,
    mimeType: r.mime_type,
    byteSize: r.byte_size,
    sha256: r.sha256,
    blobStorageUri: r.blob_storage_uri,
    sourceModifiedAt: r.source_modified_at,
    versionGroupId: r.version_group_id === null ? null : asDocumentId(r.version_group_id),
    versionSeq: r.version_seq,
    supersedesDocumentId:
      r.supersedes_document_id === null ? null : asDocumentId(r.supersedes_document_id),
    validFrom: r.valid_from,
    validTo: r.valid_to,
    sensitivityClassId: r.sensitivity_class_id,
    accessTags: r.access_tags,
    createdBy: asActorId(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function paragraphFromRow(row: Record<string, unknown>): Paragraph {
  const r = asSnake(row) as unknown as ParagraphRow;
  return {
    id: asParagraphId(r.id),
    tenantId: asTenantId(r.tenant_id),
    documentId: asDocumentId(r.document_id),
    paragraphIndex: r.paragraph_index,
    page: r.page,
    text: r.text,
    structure: (r.structure ?? {}) as Paragraph['structure'],
    accessTags: r.access_tags,
    createdBy: asActorId(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function extractorVersionFromRow(row: Record<string, unknown>): ExtractorVersion {
  const r = asSnake(row) as unknown as ExtractorVersionRow;
  return {
    id: asExtractorVersionId(r.id),
    tenantId: asTenantId(r.tenant_id),
    configurationId: r.configuration_id,
    configurationVersion: r.configuration_version,
    schemaHash: r.schema_hash,
    promptHash: r.prompt_hash,
    modelId: r.model_id,
    createdAt: r.created_at,
  };
}

interface EmbeddingRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly target_kind: 'paragraph' | 'entity';
  readonly target_id: string;
  readonly model_id: string;
  readonly vector: readonly number[] | string;
  readonly access_tags: readonly string[];
  readonly created_at: Date;
}

export function embeddingFromRow(row: Record<string, unknown>): Embedding {
  const r = asSnake(row) as unknown as EmbeddingRow;
  // pgvector returns vectors as either a JS number[] (when postgres-js
  // parses them) or the string literal '[1,2,3]'. Normalise both forms.
  const vector =
    typeof r.vector === 'string'
      ? r.vector
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map((s) => Number.parseFloat(s))
      : r.vector;
  return {
    id: asEmbeddingId(r.id),
    tenantId: asTenantId(r.tenant_id),
    targetKind: r.target_kind,
    targetId: r.target_id,
    modelId: r.model_id,
    vector,
    accessTags: r.access_tags,
    createdAt: r.created_at,
  };
}

export function reviewItemFromRow(row: Record<string, unknown>): ReviewItem {
  const r = asSnake(row) as unknown as ReviewQueueRow;
  return {
    id: asReviewItemId(r.id),
    tenantId: asTenantId(r.tenant_id),
    targetKind: r.target_kind,
    targetId: r.target_id,
    proposedChange: (r.proposed_change ?? {}) as Readonly<Record<string, unknown>>,
    proposedBy: asActorId(r.proposed_by),
    // The column is opaque text; today's writers only ever set the three known
    // states, so the cast is sound. Kept opaque so the learning loop can extend.
    status: r.status as ReviewItemStatus,
    accessTags: r.access_tags,
    reviewedBy: r.reviewed_by === null ? null : asActorId(r.reviewed_by),
    reviewedAt: r.reviewed_at,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Unused but exported for completeness with the rest of the type machinery.
export type { FromDrizzle, Snake };

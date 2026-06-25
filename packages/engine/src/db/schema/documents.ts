// Documents — references to source material stored in blob storage.
// We never store raw bytes here; `blob_storage_uri` points at Azure Blob (or
// equivalent in dev) and ingestion pulls bytes through the connector layer.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  accessTagsColumn,
  createdAtColumn,
  createdByColumn,
  deletedAtColumn,
  updatedAtColumn,
} from './_common';
import { tenants } from './tenants';

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // Connector-supplied identifier (e.g. Microsoft Graph driveItem id).
    // Used together with `connector_package` for idempotent upserts.
    externalId: text('external_id'),
    connectorPackage: text('connector_package'),

    // Logical name and content metadata. Title is what the user sees.
    title: text('title').notNull(),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'bigint' }),
    sha256: text('sha256'),

    blobStorageUri: text('blob_storage_uri').notNull(),
    sourceModifiedAt: timestamp('source_modified_at', { withTimezone: true }),

    // --- Versioning / validity window (P3a) -------------------------------
    // All nullable so existing rows are untouched by the migration. A document
    // with no version metadata is a "version of one": current, never
    // superseded. When a changed document with the same (tenant, connector,
    // external_id) is re-ingested, the new row joins (or starts) a version
    // group and the prior row is marked superseded by setting `valid_to`.
    // Superseded versions stay LIVE (not soft-deleted) and remain retrievable;
    // retrieval merely demotes them in ranking. The engine demotes by generic
    // validity/supersession — never a domain concept.
    //
    // Groups all versions of the same logical document. The first version may
    // leave this null (treated as a group of itself); the second seeds it.
    versionGroupId: uuid('version_group_id'),
    // Monotonic position within the version group (1 = first, 2 = next, …).
    versionSeq: integer('version_seq'),
    // The immediately-prior version this row supersedes (self-reference).
    supersedesDocumentId: uuid('supersedes_document_id').references(
      (): AnyPgColumn => documents.id,
      { onDelete: 'set null' },
    ),
    // Validity window. `valid_to IS NULL` ⇒ the current/live version; a set
    // `valid_to` marks a superseded version (still reachable, ranked lower).
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),

    // --- Sensitivity (F33) ------------------------------------------------
    // OPAQUE configuration-supplied class id. The engine NEVER consults this
    // for permission (access stays tag-only); it is a display/metadata field
    // persisted so the web badge reflects the picked class instead of always
    // the config default.
    sensitivityClassId: text('sensitivity_class_id'),

    // --- Near-duplicate fingerprint (P3a) ---------------------------------
    // 64-bit SimHash of the document text as a fixed-width binary string.
    // Compared by Hamming distance in application code (not SQL); stored so
    // each new ingest can scan prior fingerprints to link near-duplicates.
    simhash: text('simhash'),

    accessTags: accessTagsColumn(),
    createdBy: createdByColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [
    index('documents_tenant_idx').on(table.tenantId),
    index('documents_access_tags_gin').using('gin', table.accessTags),
    index('documents_external_idx').on(table.tenantId, table.connectorPackage, table.externalId),
    index('documents_not_deleted_idx').on(table.tenantId).where(sql`deleted_at IS NULL`),
    // Group all versions of one logical document for the supersession demote.
    index('documents_version_group_idx').on(table.tenantId, table.versionGroupId),
    // Bound the near-dup candidate scan to documents that actually carry a
    // fingerprint (a partial index over the tenant's fingerprinted rows).
    index('documents_simhash_idx')
      .on(table.tenantId)
      .where(sql`simhash IS NOT NULL`),
  ],
);

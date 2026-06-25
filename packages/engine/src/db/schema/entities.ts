// entities — polymorphic node table.
//
// The engine knows nothing about entity types beyond their opaque names.
// `type` is a string keyed by configuration; `properties` is JSONB validated
// against the configuration's entity-type property schema at ingestion time
// (Phase 1.6a).
//
// Provenance is always recorded. A `document_extract` row must carry a
// paragraph reference and an extractor_version — enforced via CHECK below.

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import {
  accessTagsColumn,
  createdAtColumn,
  createdByColumn,
  deletedAtColumn,
  sourceKind,
  updatedAtColumn,
} from './_common';
import { documents } from './documents';
import { extractorVersions } from './extractor-versions';
import { paragraphs } from './paragraphs';
import { tenants } from './tenants';

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    type: text('type').notNull(),
    properties: jsonb('properties').notNull().default(sql`'{}'::jsonb`),

    // Provenance.
    sourceKind: sourceKind('source_kind').notNull(),
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    sourceParagraphId: uuid('source_paragraph_id').references(() => paragraphs.id, {
      onDelete: 'set null',
    }),
    sourceConnectorPackage: text('source_connector_package'),
    extractorVersionId: uuid('extractor_version_id').references(() => extractorVersions.id, {
      onDelete: 'restrict',
    }),
    confidence: doublePrecision('confidence'),

    accessTags: accessTagsColumn(),
    createdBy: createdByColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [
    index('entities_tenant_type_idx').on(table.tenantId, table.type),
    index('entities_access_tags_gin').using('gin', table.accessTags),
    index('entities_source_paragraph_idx').on(table.tenantId, table.sourceParagraphId),
    index('entities_not_deleted_idx').on(table.tenantId, table.type).where(sql`deleted_at IS NULL`),
    check(
      'entities_document_extract_requires_provenance',
      sql`source_kind != 'document_extract' OR (source_paragraph_id IS NOT NULL AND extractor_version_id IS NOT NULL)`,
    ),
    check(
      'entities_confidence_range',
      sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
    ),
  ],
);

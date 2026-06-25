// edges — generic relationships between entities.
//
// Same generic shape as entities: opaque `type`, optional JSONB properties,
// full provenance. Direction is meaningful: `from_entity_id` → `to_entity_id`.

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
import { entities } from './entities';
import { extractorVersions } from './extractor-versions';
import { paragraphs } from './paragraphs';
import { tenants } from './tenants';

export const edges = pgTable(
  'edges',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    type: text('type').notNull(),
    fromEntityId: uuid('from_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    toEntityId: uuid('to_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    properties: jsonb('properties').notNull().default(sql`'{}'::jsonb`),

    // Provenance, mirroring entities.
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
    index('edges_tenant_type_idx').on(table.tenantId, table.type),
    index('edges_tenant_from_idx').on(table.tenantId, table.fromEntityId),
    index('edges_tenant_to_idx').on(table.tenantId, table.toEntityId),
    index('edges_access_tags_gin').using('gin', table.accessTags),
    index('edges_not_deleted_idx').on(table.tenantId, table.type).where(sql`deleted_at IS NULL`),
    check(
      'edges_document_extract_requires_provenance',
      sql`source_kind != 'document_extract' OR (source_paragraph_id IS NOT NULL AND extractor_version_id IS NOT NULL)`,
    ),
    check(
      'edges_confidence_range',
      sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
    ),
    check('edges_no_self_loop', sql`from_entity_id != to_entity_id`),
  ],
);

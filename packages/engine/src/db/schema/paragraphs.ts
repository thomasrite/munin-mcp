// Paragraphs — chunks of a document. The unit of extraction and citation.
// Every fact extracted from a document points at a specific paragraph.

import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import {
  accessTagsColumn,
  createdAtColumn,
  createdByColumn,
  deletedAtColumn,
  updatedAtColumn,
} from './_common';
import { documents } from './documents';
import { tenants } from './tenants';

export const paragraphs = pgTable(
  'paragraphs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    // Ordinal position within the document; used for stable citation rendering.
    paragraphIndex: integer('paragraph_index').notNull(),

    // Optional page number for PDFs. NULL for documents without paging.
    page: integer('page'),

    // The actual text. Long-tail safe: TEXT, no length limit.
    text: text('text').notNull(),

    // Structural metadata used by citation rendering in Phase 1.7.
    // Shape: { headingPath?: string[], page?: number, ordinalWithinSection?: number }.
    // The chunker fills it with whatever the source format supports;
    // unsupported fields are simply omitted.
    structure: jsonb('structure').notNull().default(sql`'{}'::jsonb`),

    accessTags: accessTagsColumn(),
    createdBy: createdByColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [
    index('paragraphs_tenant_doc_idx').on(table.tenantId, table.documentId, table.paragraphIndex),
    index('paragraphs_access_tags_gin').using('gin', table.accessTags),
    index('paragraphs_not_deleted_idx')
      .on(table.tenantId, table.documentId)
      .where(sql`deleted_at IS NULL`),
  ],
);

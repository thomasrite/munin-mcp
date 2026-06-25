// document_duplicates — near/semantic duplicate LINKS between documents (P3a).
//
// A duplicate is LINKED, never merged and never skipped. Exact-byte duplicates
// are still skipped at ingest by sha256 idempotency (the only skip); a near or
// semantic duplicate is fully ingested and a row is recorded here as metadata so
// the relationship is surfaceable without ever losing a genuinely-distinct
// document.
//
// `method` distinguishes how the link was found:
//   'near'     — SimHash Hamming distance at ingest (lexical near-copy)
//   'semantic' — embedding cosine similarity (the post-embed worker job)
//
// The link itself carries no access_tags: visibility is enforced at read time
// by joining to BOTH endpoint documents and applying the standard access
// filter, so a caller only sees a link whose documents they are permitted to
// see (see GraphStoreReader.findDuplicatesForDocument).

import { index, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { documents } from './documents';
import { tenants } from './tenants';

export const documentDuplicates = pgTable(
  'document_duplicates',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // The document this link is recorded FROM (e.g. the newly-ingested copy).
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // The pre-existing document it duplicates.
    duplicateOfDocumentId: uuid('duplicate_of_document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    // 'near' | 'semantic'. Plain text (not an enum) — the set is small and a
    // text column keeps the migration trivial; the writer validates the union.
    method: text('method').notNull(),
    // Similarity score in [0,1]: SimHash 1 - hamming/64 for 'near'; cosine
    // similarity for 'semantic'. Higher = more similar.
    score: real('score').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('document_duplicates_tenant_doc_idx').on(table.tenantId, table.documentId),
    index('document_duplicates_tenant_dupof_idx').on(table.tenantId, table.duplicateOfDocumentId),
    // Idempotent recording: re-running detection records the same link once.
    uniqueIndex('document_duplicates_natural_key').on(
      table.tenantId,
      table.documentId,
      table.duplicateOfDocumentId,
      table.method,
    ),
  ],
);

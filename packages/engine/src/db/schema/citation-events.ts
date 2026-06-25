// citation_events — per-citation implicit-feedback telemetry (the learning-loop
// seed). Mirrors query_events in spirit: deliberately content-free / PII-free.
//
// One row per source paragraph CITED in a produced answer or generated document.
// An answer that cites 3 paragraphs writes 3 rows. Captures WHO (actor), WHEN,
// and WHICH source (paragraph_id + its document_id) — but NEVER the paragraph
// text, the quote, the question, or any content/PII (same DPO-facing discipline
// as query_events). The signal is purely COUNT(*) GROUP BY paragraph_id per
// tenant: which sources get cited, the implicit "this was useful" feedback that
// later powers a per-tenant/team citation-frequency ranking boost.
//
// This data cannot be retrofitted, so it is collected from session one. Reads are
// tenant-scoped and (in the GraphStore reader) gated by the caller's access tags
// via a join to paragraphs — a citation count is only ever returned for a
// paragraph the caller can already see.

import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './_common';
import { documents } from './documents';
import { paragraphs } from './paragraphs';
import { tenants } from './tenants';

export const citationEvents = pgTable(
  'citation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    // Entra OID / connector name / 'system'/'cli:query'. NOT access-tag-gated on
    // the row itself: the row carries no content. Reads are tenant-scoped and
    // access-gated by joining to the cited paragraph (see countCitationsByParagraph).
    actor: text('actor').notNull(),
    // The cited source. FK with ON DELETE CASCADE so a hard-deleted document /
    // paragraph (right-to-erasure) takes its citation telemetry with it.
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    paragraphId: uuid('paragraph_id')
      .notNull()
      .references(() => paragraphs.id, { onDelete: 'cascade' }),
    // Deliberately no quote / text / question column: content-free by design.
    occurredAt: createdAtColumn(),
  },
  (table) => [
    // The frequency signal: COUNT(*) GROUP BY paragraph_id within a tenant.
    index('citation_events_tenant_paragraph_idx').on(table.tenantId, table.paragraphId),
    // Time-windowed analysis (recency-weighted frequency later) + per-tenant scans.
    index('citation_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
  ],
);

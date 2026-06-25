// internal_bypass_log — every INTERNAL_BYPASS read is logged here.
//
// This is the audit of last resort. It is *separate* from audit_events so
// that it can be architecturally enforced as tamper-evident: DELETE,
// UPDATE, and TRUNCATE are blocked at the row level via triggers added in
// the migration. Production DB role configuration should additionally
// revoke UPDATE/DELETE/TRUNCATE on this table for the application role.
//
// If you ever find yourself wanting to delete rows here, the answer is
// almost certainly to stop using INTERNAL_BYPASS where you are using it,
// not to clear the audit.

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './_common';
import { tenants } from './tenants';

export const internalBypassLog = pgTable(
  'internal_bypass_log',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // Where the bypass was invoked. A stable code path identifier such as
    // 'ingest.extractor.persistEntities' or 'admin.purge.softDelete'.
    callSite: text('call_site').notNull(),

    // The justification recorded by the caller. Must be non-empty;
    // application code is responsible for forcing a meaningful reason.
    reason: text('reason').notNull(),

    // What the read touched, for forensic reconstruction. Free-form JSONB;
    // small payloads only.
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),

    occurredAt: createdAtColumn(),
  },
  (table) => [
    index('internal_bypass_log_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('internal_bypass_log_call_site_idx').on(table.callSite, table.occurredAt),
  ],
);

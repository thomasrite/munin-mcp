// audit_events — the accountability trail data-protection officers ask for.
//
// Populated on every shared-graph MUTATION (P6a: updateEntity/updateEdge write
// one row here in the same transaction as the change) AND, since G2b
// (F10/F26), on every regular READ through the AuditedGraphStore decorator —
// one content-free row per read call, written by the batched fail-open
// BatchedReadAuditWriter (graph/read-audit.ts), enabled by default via
// MUNIN_READ_AUDIT. Append-only at the application level; production DB role
// configuration should additionally restrict UPDATE/DELETE permissions on
// this table.

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './_common';
import { tenants } from './tenants';

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // Opaque actor identifier. Entra ID OID for user reads; connector
    // package name for connector reads; 'system' for internal jobs.
    actor: text('actor').notNull(),

    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id'),

    accessTagsUsed: text('access_tags_used').array().notNull().default(sql`ARRAY[]::text[]`),

    // Free-form additional context. Keep small; this is not a place for raw
    // entity payloads.
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),

    occurredAt: createdAtColumn(),
  },
  (table) => [
    index('audit_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('audit_events_actor_idx').on(table.tenantId, table.actor),
    index('audit_events_target_idx').on(table.tenantId, table.targetKind, table.targetId),
  ],
);

// connector_state — per-tenant, per-connector cursor and state.
//
// Each connector stores its delta tokens, last-sync timestamps, error
// counts, and configuration snapshot here. State is opaque to the engine;
// JSONB.

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const connectorState = pgTable(
  'connector_state',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    connectorPackage: text('connector_package').notNull(),

    // Connector-specific state.
    state: jsonb('state').notNull().default(sql`'{}'::jsonb`),

    // Bookkeeping outside the JSONB so it's queryable.
    lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
    lastSyncCompletedAt: timestamp('last_sync_completed_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    consecutiveErrorCount: jsonb('consecutive_error_count').notNull().default(sql`'0'::jsonb`),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('connector_state_tenant_package_idx').on(table.tenantId, table.connectorPackage),
  ],
);

// tenant_directory — CONTROL-PLANE mapping: Entra tenant id → Munin tenant.
//
// This is the one lookup that must happen BEFORE connecting to a tenant's
// database (v1 gives each tenant its own Postgres DB), so it is logically a
// control-plane concern, not per-tenant data. In dev it lives in the local DB
// for convenience; production (Phase 5) repoints the `TenantDirectory` interface
// to a real control-plane registry. Fail-closed: an unmapped Entra tenant id
// resolves to no tenant, and the request is denied.

import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, deletedAtColumn, updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const tenantDirectory = pgTable(
  'tenant_directory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entraTenantId: text('entra_tenant_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [
    // One live mapping per Entra tenant.
    uniqueIndex('tenant_directory_entra_tid_idx')
      .on(table.entraTenantId)
      .where(sql`deleted_at IS NULL`),
  ],
);

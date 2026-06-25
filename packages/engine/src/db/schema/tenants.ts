// The tenant registry. One row per logical tenant.
//
// In production hosted SaaS, each customer gets its own logical Postgres
// database with typically a single row in this table — the tenant whose
// data lives in that database. In dev/test we frequently run many tenants
// in one database for cheap isolation testing; multiple rows are allowed.
//
// `cmk_key_reference` holds an opaque pointer to the customer's
// customer-managed key (Key Vault URI or equivalent). NULL means the
// tenant is using platform-managed keys (dev/test only).

import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAtColumn, deletedAtColumn, updatedAtColumn } from './_common';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    cmkKeyReference: text('cmk_key_reference'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    deletedAt: deletedAtColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index('tenants_not_deleted_idx').on(table.id).where(sql`deleted_at IS NULL`)],
);

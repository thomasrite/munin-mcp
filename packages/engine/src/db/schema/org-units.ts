// org_units — per-tenant organisational tree (D3).
//
// Vertical-agnostic: `kind` is an opaque string (a configuration decides that
// 'office' nests under 'org'); the engine never interprets it. `tags` are the
// access tags the unit grants. Flat configurations (generic-demo, HR
// institutional-only) simply have no rows here. Rich multi-level trees are
// populated for departmental access (B1) via the TenancyStore.upsertOrgUnit writer.

import { sql } from 'drizzle-orm';
import { type AnyPgColumn, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { accessTagsColumn, createdAtColumn, deletedAtColumn, updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const orgUnits = pgTable(
  'org_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    // Self-referential parent (null at the root). Annotated type for the
    // forward self-reference per drizzle.
    parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, {
      onDelete: 'restrict',
    }),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    // Access tags this unit grants (reuses the standard access_tags column).
    tags: accessTagsColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [index('org_units_tenant_idx').on(table.tenantId).where(sql`deleted_at IS NULL`)],
);

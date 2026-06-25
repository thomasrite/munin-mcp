// user_unit_assignments — per-tenant user → org-unit placement (D3).
//
// Assigns a user (by Entra object id) to an org unit, optionally with a role.
// Carries the per-user SCOPE for departmental access (B1): the resolver folds an
// assigned unit's tags into the user's access. Vertical-agnostic — the engine
// stores opaque rows; the configuration decides what a unit's tags mean.

import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, deletedAtColumn, updatedAtColumn } from './_common';
import { orgUnits } from './org-units';
import { tenants } from './tenants';

export const userUnitAssignments = pgTable(
  'user_unit_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    // Entra object id (oid) of the user.
    actorOid: text('actor_oid').notNull(),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'restrict' }),
    roleName: text('role_name'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [
    index('user_unit_assignments_tenant_actor_idx')
      .on(table.tenantId, table.actorOid)
      .where(sql`deleted_at IS NULL`),
    // One LIVE assignment per (tenant, actorOid, orgUnitId) — the natural key for
    // idempotent upsert. roleName is updatable metadata, not part of the key.
    uniqueIndex('user_unit_assignments_unique_idx')
      .on(table.tenantId, table.actorOid, table.orgUnitId)
      .where(sql`deleted_at IS NULL`),
  ],
);

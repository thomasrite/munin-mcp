// group_role_bindings — per-tenant identity → configuration-role mapping (D3).
//
// Maps an Entra subject (an app-role value or a security-group OID — D5: keyed
// by the immutable value/OID, never a display name) to a configuration role
// name, optionally scoped to an org unit. This is the per-tenant data the
// permission resolver reads to turn a signed-in user's `roles[]` claim into the
// configuration roles whose baseTags drive access-tag expansion.

import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, deletedAtColumn, updatedAtColumn } from './_common';
import { orgUnits } from './org-units';
import { tenants } from './tenants';

// What kind of Entra subject the binding's subject_id refers to.
export const bindingSubjectKind = pgEnum('binding_subject_kind', ['app_role', 'group']);

export const groupRoleBindings = pgTable(
  'group_role_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    subjectKind: bindingSubjectKind('subject_kind').notNull(),
    // The Entra app-role value or group object id (immutable identifier).
    subjectId: text('subject_id').notNull(),
    // The configuration role this subject maps to.
    roleName: text('role_name').notNull(),
    // Optional org-unit scope (B1 — org-unit-scoped roles). NULL → unscoped
    // (granted unconditionally); set → granted only within that unit's subtree.
    scopeOrgUnitId: uuid('scope_org_unit_id').references(() => orgUnits.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (table) => [
    index('group_role_bindings_tenant_idx').on(table.tenantId).where(sql`deleted_at IS NULL`),
    // Org-unit-scoped uniqueness (B1). TWO partial unique indexes, because
    // Postgres treats every NULL as distinct: a single index over the nullable
    // scope column would let unlimited duplicate UNSCOPED (NULL-scope) bindings
    // in. So we split:
    //   • unscoped — one live binding per (tenant, subject, role) where scope IS NULL
    //   • scoped   — one live binding per (tenant, subject, role, scope) where scope IS NOT NULL
    // Together they guarantee exactly one live unscoped binding per (subject,
    // role) AND exactly one live scoped binding per (subject, role, scope).
    uniqueIndex('group_role_bindings_unscoped_unique_idx')
      .on(table.tenantId, table.subjectKind, table.subjectId, table.roleName)
      .where(sql`deleted_at IS NULL AND scope_org_unit_id IS NULL`),
    uniqueIndex('group_role_bindings_scoped_unique_idx')
      .on(table.tenantId, table.subjectKind, table.subjectId, table.roleName, table.scopeOrgUnitId)
      .where(sql`deleted_at IS NULL AND scope_org_unit_id IS NOT NULL`),
  ],
);

// style_profiles — one small, always-injected per-(tenant, actor) style summary (P5a).
//
// Where learned_rules is a GROWING list of discrete rules (top-N injected), the
// style profile is a SINGLE short paragraph describing the actor's overall house
// style. It is overwritten in place (one row per (tenant, actor, scope)) and is
// ALWAYS injected (it is tiny), so a user's broad preferences carry even before
// enough discrete rules have accumulated.
//
// PER-(tenant, actor) METADATA, NOT A GRAPH FACT — same isolation contract as the
// other learning tables. Personal-scoped only (P5a); the store rejects any
// non-'personal' write.

import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const styleProfiles = pgTable(
  'style_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    actor: text('actor').notNull(),
    scope: text('scope').notNull().default('personal'),

    // The short always-injected style summary. Opaque to the engine.
    profileText: text('profile_text').notNull(),

    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // One profile per (tenant, actor, scope) — the upsert key (overwrite in place).
    uniqueIndex('style_profiles_tenant_actor_scope_key').on(
      table.tenantId,
      table.actor,
      table.scope,
    ),
  ],
);

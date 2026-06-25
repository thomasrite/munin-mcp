// review_queue — the governed-correction review queue (P6a).
//
// Any authenticated user may SUGGEST a correction: a row lands here with status
// 'pending' and ZERO effect on the shared graph. Only a steward (a holder of the
// REVIEW_CORRECTIONS capability) may APPROVE — apply the change to the shared
// graph (audited) — or REJECT. The defining invariant (the golden rule) is that
// a single user's suggestion never becomes a shared fact without that
// human-gated approval step.
//
// Deliberately GENERIC so the post-pilot learning loop reuses this ONE queue
// rather than forking a second: `target_kind` is an OPEN, extensible string
// ('entity'/'edge' now; 'learned_rule' etc. later) the engine never interprets,
// and `proposed_change` is opaque JSONB (the patch/correction payload the web
// layer writes and reads back — the engine stores it verbatim).
//
// `access_tags` carries the TARGET's access tags so the queue read is
// access-gated by the SAME array-overlap (&&) filter as every content read — a
// steward sees only items whose target they are permitted to see.

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { accessTagsColumn, createdAtColumn, updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const reviewQueue = pgTable(
  'review_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // OPEN, extensible kind of the target this correction concerns. 'entity' /
    // 'edge' today; the learning loop will enqueue e.g. 'learned_rule'. Opaque to
    // the engine — the web layer interprets it when applying an approval.
    targetKind: text('target_kind').notNull(),
    // The target's id (an entity/edge uuid today). Nullable: a target_kind that
    // is not a graph row (a proposed rule) may have no uuid target.
    targetId: uuid('target_id'),

    // The correction payload — the patch the web layer applies on approval.
    // OPAQUE JSONB: the engine stores + returns it verbatim, never interprets it.
    proposedChange: jsonb('proposed_change').notNull().default(sql`'{}'::jsonb`),

    // Opaque actor (Entra OID) who suggested the correction.
    proposedBy: text('proposed_by').notNull(),

    // Lifecycle: 'pending' (no shared effect) → 'approved' | 'rejected'. Plain
    // text (not a pg enum) so the learning loop can add states without a
    // type-altering migration — kept extensible like target_kind.
    status: text('status').notNull().default('pending'),

    // The TARGET's access tags, copied onto the row at enqueue time so the queue
    // read is access-gated by the same array-overlap filter as every read.
    accessTags: accessTagsColumn(),

    // Set when a steward resolves the item.
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // Optional free-text note (the suggester's reason, or the steward's). Small;
    // not a place for raw entity/document content.
    note: text('note'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // The steward's pending-queue read path: tenant + status, oldest first.
    index('review_queue_tenant_status_created_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    // GIN over access_tags so the array-overlap (&&) access filter is indexable,
    // matching every other access-tagged table.
    index('review_queue_access_tags_gin').using('gin', table.accessTags),
  ],
);

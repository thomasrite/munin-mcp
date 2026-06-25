// generation_feedback — the (draft → human-final) learning signal (P5a).
//
// When a human edits/finalises a grounded generated draft, ONE row lands here:
// the draft Munin produced + the human's finalised version + their decision.
// From that diff the web layer infers a small reusable STYLE rule (learned_rules)
// that is injected into THAT user's future generations.
//
// PER-(tenant, actor) METADATA, NOT A GRAPH FACT. This is not an entity/edge/
// document; it is never read through the GraphStore access-tag path and is never
// cited. Its isolation boundary is the (tenant_id, actor) pair — one actor's
// feedback never reaches another, one tenant's never reaches another.
//
// CONTENT-BEARING → PERSONAL-SCOPED. `model_draft` and `human_final` hold real
// content (the draft and the human's wording), so `scope` is locked to 'personal'
// in P5a (shared-rule promotion is P5b). RETENTION (G2a/F55): the content columns
// are NULLABLE because a retention sweep scrubs them IN PLACE past the TTL —
// content NULLed, `content_scrubbed_at` stamped — while the row skeleton
// (decision/context/scope metadata + any rule linkage) survives for provenance.
// The learned rule is the durable artifact; the raw draft/final are a liability
// on a clock.

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './_common';
import { tenants } from './tenants';

export const generationFeedback = pgTable(
  'generation_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // Opaque actor (Entra OID) whose finalisation produced this signal. Half of
    // the per-(tenant, actor) isolation key.
    actor: text('actor').notNull(),

    // NON-CONTENT metadata only: document/template id, etc. NEVER record or
    // document text (that rides in model_draft/human_final). Opaque to the engine.
    context: jsonb('context').notNull().default(sql`'{}'::jsonb`),

    // The draft Munin generated and the human's finalised version. Content-bearing
    // (see header) — the (draft → final) diff is exactly the learning signal.
    // NULLABLE (0015): NULL after the retention sweep scrubs the content in place
    // (`content_scrubbed_at` records when). New rows always carry both.
    modelDraft: text('model_draft'),
    humanFinal: text('human_final'),

    // 'approve' | 'reject' | 'edit'. Plain text (not a pg enum) so the learning
    // loop can add decisions without a type-altering migration.
    decision: text('decision').notNull(),

    // Scope-lock: 'personal' only in P5a. Plain text, kept extensible like
    // review_queue.status — P5b adds 'shared' WITHOUT a schema change. The store
    // rejects any non-'personal' write; no DB CHECK so P5b need not drop one.
    scope: text('scope').notNull().default('personal'),

    // The rule inferred from this signal, set AFTER inference runs (nullable until
    // then). Deliberately NOT a FK: learned_rules.source_feedback_id already FKs
    // back here, and a second FK the other way would make the pair mutually
    // dependent (a create-order cycle). The provenance gate lives on that side.
    inferredRuleId: uuid('inferred_rule_id'),
    confidence: real('confidence'),

    // Set when the retention sweep (or a DSAR scrub) NULLed model_draft +
    // human_final in place (0015). NULL ⇒ content intact. The marker is the
    // sweep's idempotency key AND the honest record that content once existed.
    contentScrubbedAt: timestamp('content_scrubbed_at', { withTimezone: true }),

    createdAt: createdAtColumn(),
  },
  (table) => [
    // The per-actor read path: a tenant's actor's feedback, newest first.
    index('generation_feedback_tenant_actor_idx').on(table.tenantId, table.actor, table.createdAt),
  ],
);

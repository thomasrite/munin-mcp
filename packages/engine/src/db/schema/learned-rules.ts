// learned_rules — reusable per-(tenant, actor) style/preference rules (P5a).
//
// Each row is ONE abstract style rule inferred from a (draft → human-final)
// signal (generation_feedback). At generation time the actor's rules are loaded,
// ranked (read-time decay), and injected into the user message so the new draft
// already follows their preferences. The text is OPAQUE to the engine — it stores
// and returns it verbatim; it names no vertical concept.
//
// PER-(tenant, actor) METADATA, NOT A GRAPH FACT — same isolation contract as
// generation_feedback. One actor's rules never reach another.
//
// PROVENANCE-GATED: `source_feedback_id` is NOT NULL and FKs to the feedback row
// the rule was inferred from — there is no rule without a source. (Only this
// direction is FK'd; generation_feedback.inferred_rule_id is a plain uuid, to
// avoid a mutual create-order cycle.)
//
// DEDUP via EMBEDDING: a 1024-dim embedding (same dim as the paragraph/entity
// embeddings) lets the store recognise a near-duplicate rule (cosine ≥ 0.92) and
// REINFORCE the existing one instead of inserting a second row. `rule_key` is a
// SEPARATE, deterministic conflict key used at read time (same key → higher
// confidence then more recent wins) — not the dedup mechanism.

import { index, integer, pgTable, real, text, uuid, vector } from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './_common';
import { EMBEDDING_DIMENSIONS } from './embeddings';
import { generationFeedback } from './generation-feedback';
import { tenants } from './tenants';

export const learnedRules = pgTable(
  'learned_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // Per-(tenant, actor) isolation key (the rule's owner).
    actor: text('actor').notNull(),

    // 'personal' (a user's own rule) or 'shared' (a tenant-wide company default,
    // P5b). A 'shared' row is written ONLY by the gated LearningStore.writeSharedRule
    // (the steward-approved review-queue promotion); every non-gated write rejects
    // any scope but 'personal'. For a shared row `actor` holds the approving steward.
    scope: text('scope').notNull().default('personal'),

    // The abstract style rule, opaque to the engine (stored + returned verbatim).
    ruleText: text('rule_text').notNull(),
    // Deterministic conflict key (e.g. a normalised dimension). Same key → the
    // read-time resolver keeps the higher-confidence, then more-recent rule.
    ruleKey: text('rule_key').notNull(),

    // Semantic fingerprint for near-duplicate detection (cosine ≥ 0.92 → reinforce).
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),

    // PROVENANCE GATE: every rule traces to the feedback signal it came from.
    sourceFeedbackId: uuid('source_feedback_id')
      .notNull()
      .references(() => generationFeedback.id, { onDelete: 'restrict' }),

    // Read-time decay ranks by recency × confidence; reinforcement bumps both the
    // count and (toward 1) the confidence.
    confidence: real('confidence').notNull(),
    reinforcementCount: integer('reinforcement_count').notNull().default(1),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // The per-actor load path (injection): a tenant's actor's personal rules.
    index('learned_rules_tenant_actor_idx').on(table.tenantId, table.actor, table.scope),
    // HNSW cosine index so the dedup nearest-neighbour probe is indexable, exactly
    // like the embeddings table.
    index('learned_rules_embedding_hnsw').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
);

// Public types for the per-(tenant, actor) learning-metadata store (P5a).
//
// GENERIC / vertical-agnostic: rule_text / rule_key / profile_text / the feedback
// content are OPAQUE strings the engine stores and returns verbatim. The engine
// names no vertical concept and never interprets a rule.

import type { ActorId, TenantId } from '../graph/types';

// The isolation key for every learning read/write. One actor's rows never reach
// another; one tenant's never reach another. Mirrors WriteContext's shape but is
// deliberately separate — these are NOT graph facts and carry no accessTags.
export interface LearningContext {
  readonly tenantId: TenantId;
  readonly actor: ActorId;
}

// The review_queue.target_kind under which the web's promotion path enqueues a
// "make my rule a team default" item (P5b) — and which the DSAR erasure sweep
// (eraseActorLearning) matches when deleting pending promotions of erased rules.
// ONE constant on purpose: the sweep is load-bearing (a stale pending promotion
// could be approved after erasure), so the enqueue and the sweep must never
// drift apart on the kind string. Engine-tier learning-loop vocabulary, not a
// vertical concept; the queue itself stays an open string the engine never
// interprets.
export const LEARNED_RULE_REVIEW_TARGET_KIND = 'learned_rule' as const;

// 'personal' — one (tenant, actor)'s own rules. 'shared' — tenant-wide company
// defaults (P5b). A shared rule can ONLY be created by the gated writeSharedRule
// (called from the steward-approved review-queue promotion); every NON-gated
// write (recordFeedback / insertRule / upsertStyleProfile) still rejects any
// scope other than 'personal'. So no shared rule is ever written outside the
// human-gated promotion path.
export type LearningScope = 'personal' | 'shared';

// What the human did with the draft. Plain union — extensible without a migration.
export type FeedbackDecision = 'approve' | 'reject' | 'edit';

// Opaque, NON-CONTENT metadata about the generation the feedback came from
// (document/template id, etc.). The engine never interprets it; it never holds
// record/document text (that is model_draft/human_final).
export type FeedbackContext = Readonly<Record<string, unknown>>;

export interface RecordFeedbackInput {
  readonly context: FeedbackContext;
  readonly modelDraft: string;
  readonly humanFinal: string;
  readonly decision: FeedbackDecision;
  readonly scope: LearningScope;
}

export interface GenerationFeedback {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly actor: ActorId;
  readonly context: FeedbackContext;
  // NULL after the retention sweep scrubbed the content in place (0015) — the
  // row skeleton + metadata survive for provenance; the raw draft/final do not.
  readonly modelDraft: string | null;
  readonly humanFinal: string | null;
  readonly decision: FeedbackDecision;
  readonly scope: LearningScope;
  readonly inferredRuleId: string | null;
  readonly confidence: number | null;
  // When the sweep NULLed modelDraft + humanFinal. NULL ⇒ content intact.
  readonly contentScrubbedAt: Date | null;
  readonly createdAt: Date;
}

export interface InsertRuleInput {
  // PROVENANCE GATE — required. A rule with no source feedback is rejected.
  readonly sourceFeedbackId: string;
  readonly scope: LearningScope;
  // Opaque to the engine.
  readonly ruleText: string;
  readonly ruleKey: string;
  // 1024-dim (EMBEDDING_DIMENSIONS). Used for ≥0.92 cosine dedup-reinforce.
  readonly embedding: readonly number[];
  readonly confidence: number;
}

// Input to the GATED shared-rule write (P5b). No `scope` field — writeSharedRule
// forces scope='shared'; it is the SINGLE place a shared rule is created, called
// only from the steward-approved promotion. Provenance is inherited from the
// promoted personal rule: `sourceFeedbackId` is the personal rule's source
// feedback (the provenance gate), and the approving steward is recorded as the
// row's `actor`. Dedup-reinforce probes the TENANT's existing shared rules
// (NOT actor-scoped) — two stewards promoting near-identical rules reinforce one.
export interface WriteSharedRuleInput {
  // PROVENANCE GATE — required, inherited from the promoted personal rule.
  readonly sourceFeedbackId: string;
  // Opaque to the engine.
  readonly ruleText: string;
  readonly ruleKey: string;
  // 1024-dim (EMBEDDING_DIMENSIONS). Used for ≥0.92 cosine dedup-reinforce
  // against the tenant's existing SHARED rules.
  readonly embedding: readonly number[];
  readonly confidence: number;
}

export interface LearnedRule {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly actor: ActorId;
  readonly scope: LearningScope;
  readonly ruleText: string;
  readonly ruleKey: string;
  readonly sourceFeedbackId: string;
  readonly confidence: number;
  readonly reinforcementCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// The result of insertRule, so callers can tell a fresh insert from a reinforce
// (e.g. for telemetry / linking the feedback row).
export interface InsertRuleResult {
  readonly rule: LearnedRule;
  // true → an existing near-duplicate (cosine ≥ 0.92) was reinforced instead of a
  // second row being inserted.
  readonly reinforced: boolean;
}

export interface StyleProfile {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly actor: ActorId;
  readonly scope: LearningScope;
  readonly profileText: string;
  readonly updatedAt: Date;
}

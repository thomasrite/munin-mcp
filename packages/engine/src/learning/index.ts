// Learning layer (P5a/P5b) — per-(tenant, actor) preference capture + tenant-wide
// shared defaults.
//
// Capture a human's edits to a grounded draft, infer a reusable personal style
// rule, and inject that user's accumulated rules into their future generations.
// P5b adds SHARED (tenant-wide) rules: a personal rule can be promoted to a
// company default via a steward-approved review-queue promotion (writeSharedRule
// is the single, gated write); shared rules load tenant-wide and are injected as
// the baseline beneath a user's personal overrides.
//
// GENERIC / vertical-agnostic: the store treats rule text as opaque; the engine
// names no vertical concept and never reads a learning table from the generation
// path (rules reach generation only as a caller-supplied user-message string —
// the cache-safety injection invariant, see query/generate.ts).

export {
  LearningStore,
  RULE_DEDUP_SIMILARITY,
  RULE_TEXT_MAX_CHARS,
  RULE_TEXT_MAX_LINES,
} from './learning-store';
export { LEARNED_RULE_REVIEW_TARGET_KIND } from './types';
export {
  LearningStoreError,
  LearningScopeError,
  LearningProvenanceError,
  LearningRuleBoundsError,
  LearningOwnershipError,
} from './errors';
export type {
  LearningContext,
  LearningScope,
  FeedbackDecision,
  FeedbackContext,
  RecordFeedbackInput,
  GenerationFeedback,
  InsertRuleInput,
  InsertRuleResult,
  WriteSharedRuleInput,
  LearnedRule,
  StyleProfile,
} from './types';

// Cache-safe diff→rule inference (P5a-4): the static argument-free prompt + the
// inferRule helper. The draft/final ride in the user message only; the inferred
// rule is a STYLE rule, never a content fact.
export {
  assembleRuleInferencePrompt,
  RULE_INFERENCE_TOOL_NAME,
  RULE_INFERENCE_PROMPT_VERSION,
  type AssembledRuleInferencePrompt,
} from './rule-inference-prompt';
export {
  inferRule,
  RULE_INFERENCE_MODEL,
  type InferRuleInput,
  type InferredRule,
} from './infer-rule';

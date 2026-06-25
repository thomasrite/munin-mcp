// Typed Error subclasses for the LearningStore's enforced invariants (P5a).

export class LearningStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningStoreError';
  }
}

// Raised when a NON-gated write (recordFeedback / insertRule / upsertStyleProfile)
// asks for any scope other than 'personal'. A shared rule is created ONLY by the
// gated writeSharedRule (the steward-approved review-queue promotion, P5b) — this
// guard guarantees no shared rule can be written through the open personal paths.
export class LearningScopeError extends LearningStoreError {
  constructor(scope: string) {
    super(
      `this learning write is personal-only; refusing scope='${scope}'. A shared rule is created only by the gated writeSharedRule (steward-approved promotion, P5b).`,
    );
    this.name = 'LearningScopeError';
  }
}

// Raised when a rule insert carries no source feedback id — the provenance gate.
// Every learned rule must trace to the (draft → final) signal it came from.
export class LearningProvenanceError extends LearningStoreError {
  constructor() {
    super('a learned rule requires a non-empty sourceFeedbackId (provenance gate).');
    this.name = 'LearningProvenanceError';
  }
}

// Raised when a rule's text violates the deterministic size bounds (G2a/P2-1):
// empty, over the character cap, or over the line cap. Applied at BOTH write
// paths (insertRule + writeSharedRule), so no oversized rule can enter the
// store from any path. Size-only on purpose: the audit also suggested content
// heuristics (URL/imperative detection), rejected as brittle content judgment
// — false positives on legitimate style rules, no crisp pass/fail line. Size
// is crisp policy; the steward gate is the content judge for shared rules.
export class LearningRuleBoundsError extends LearningStoreError {
  constructor(what: string) {
    super(`rule text out of bounds: ${what}.`);
    this.name = 'LearningRuleBoundsError';
  }
}

// Raised when a caller-supplied cross-reference (a sourceFeedbackId or a rule id)
// does not belong to the caller's tenant (and, where required, actor). Defence in
// depth (F56): unreachable in the current flows, but the store never trusts the
// caller for tenant-correctness of a provenance pointer — the FK alone only
// proves the referenced row exists in SOME tenant.
export class LearningOwnershipError extends LearningStoreError {
  constructor(what: string) {
    super(`ownership check failed: ${what}.`);
    this.name = 'LearningOwnershipError';
  }
}

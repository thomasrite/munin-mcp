// eraseActorLearning — the DSAR erasure of ONE actor's learning data (G2a/F55).
//
// "Delete my learning data" for a (tenant, actor): personal learned rules and
// the style profile are DELETED; generation_feedback is DELETED except rows a
// SHARED rule still references — a steward-approved promotion made that rule
// company property, so its provenance pointer must keep resolving and the row
// is SCRUBBED in place instead (content NULL, marker stamped; the FK ON DELETE
// restrict enforces exactly this split). Pending review-queue promotions of the
// deleted rules are swept too — load-bearing: a stale pending promotion still
// carries the rule text in proposed_change and could otherwise be APPROVED
// after erasure, resurrecting erased data as a company default.
//
// ONE transaction: the deletes, the scrubs, the queue sweep, and the single
// content-free audit row commit or roll back together — a failure leaves no
// partial state. Like the retention sweep there is NO internalBypass: the
// learning tables carry no access_tags, and the queue sweep is a tenant-scoped
// WRITE (writes never consult access tags — same contract as
// resolveReviewItem). Tenant isolation holds on every statement.
//
// The caller (the admin/DPO web action) owns AUTHORISATION — this function,
// like every engine write, trusts its WriteContext. ctx.actor is the REQUESTING
// admin (recorded in the audit row); the actor being erased is the explicit
// parameter. Run it AFTER the actor's access is revoked; it is safe to re-run
// (idempotent — a second pass finds nothing and writes a zero-count audit row).
//
// HONEST RESIDUALS — what deliberately survives this erasure:
//   • RESOLVED review items (the decision trail): kept, including their
//     proposed_change payloads, which age out via the F54 resolved-item
//     retention scrub (same G2a batch) rather than being deleted here.
//   • The actor's opaque IDENTIFIER (never content) on accountability records:
//     audit_events rows, review_queue.proposed_by/reviewed_by, and
//     learned_rules.actor on SHARED rules they approved as steward — an
//     erasure/decision record must say who acted to be accountable.
//   • Only 'learned_rule' promotions of the deleted rules are swept here; any
//     OTHER review item a caller enqueued embedding learning content is that
//     caller's to sweep.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { GraphStoreDb } from '../graph/graph-store-factory';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import type { ActorId, TenantId, WriteContext } from '../graph/types';
import { LearningStore } from '../learning/learning-store';
import { LEARNED_RULE_REVIEW_TARGET_KIND } from '../learning/types';

// Content-free tally for the receipt + the audit row. Counts only — never rule
// text, never draft/final content.
export interface ActorLearningErasureCounts {
  readonly personalRulesDeleted: number;
  readonly styleProfilesDeleted: number;
  readonly feedbackDeleted: number;
  // Rows RETAINED (scrubbed in place) because a shared rule references them —
  // reported so the receipt is honest about what stayed and why.
  readonly feedbackScrubbed: number;
  readonly pendingRulePromotionsDeleted: number;
}

// The content-free erasure receipt — the DPO record.
export interface ActorLearningErasureReceipt {
  readonly tenantId: TenantId;
  readonly erasedActor: ActorId;
  readonly requestedBy: ActorId;
  readonly counts: ActorLearningErasureCounts;
  readonly occurredAt: Date;
}

export async function eraseActorLearning(
  db: GraphStoreDb,
  ctx: WriteContext,
  erasedActor: ActorId,
): Promise<ActorLearningErasureReceipt> {
  const occurredAt = new Date();
  // Both drivers implement the same Drizzle transaction API at runtime; the
  // narrowing is a compile-time convenience (see LearningStore's constructor).
  const dbForTx = db as PostgresJsDatabase;
  return dbForTx.transaction(async (tx) => {
    const learning = new LearningStore(tx);
    const graph = new PostgresGraphStore(tx);

    const erased = await learning.eraseActorLearningData(ctx.tenantId, erasedActor);

    // Sweep PENDING promotions of the now-deleted personal rules. Resolved
    // items are the decision trail — they stay (their payloads age out via the
    // F54 resolved-item retention scrub, not here; see HONEST RESIDUALS above).
    const pendingRulePromotionsDeleted = await graph.deletePendingReviewItemsByTargets(
      ctx,
      LEARNED_RULE_REVIEW_TARGET_KIND,
      erased.deletedRuleIds,
    );

    const counts: ActorLearningErasureCounts = {
      personalRulesDeleted: erased.personalRulesDeleted,
      styleProfilesDeleted: erased.styleProfilesDeleted,
      feedbackDeleted: erased.feedbackDeleted,
      feedbackScrubbed: erased.feedbackScrubbed,
      pendingRulePromotionsDeleted,
    };

    // The in-tx audit row. target_id is uuid-typed, so the tenant is the target
    // and the erased actor (an opaque identifier, not content) rides in details
    // — an erasure record must say WHOSE data was erased to be accountable.
    await graph.recordAuditEvent(ctx, {
      action: 'erase_actor_learning',
      targetKind: 'tenant',
      targetId: ctx.tenantId,
      accessTagsUsed: [],
      details: { erasedActor, ...counts },
    });

    return { tenantId: ctx.tenantId, erasedActor, requestedBy: ctx.actor, counts, occurredAt };
  });
}

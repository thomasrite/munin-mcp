// Data-retention sweep (G2a: the F55 feedback-content leg + the F54
// resolved-review-item leg).
//
// THE PRINCIPLE: the abstract learned rule is the durable artifact; raw content
// is a liability on a clock. The sweep scrubs CONTENT in place past a TTL — the
// row skeleton, decisions, timestamps, and audit trail survive for provenance —
// it never deletes rows and never touches anything pending or unexpired.
//
// ONE transaction per run: the scrub(s) and the single content-free audit row
// (counts only, never content) commit or roll back together, so the audit trail
// can never claim a sweep that didn't happen (and vice versa).
//
// TENANT-SCOPED SYSTEM MAINTENANCE on non-access-tagged metadata tables — no
// internalBypass: there is no access filter to bypass (tenant isolation is the
// only boundary and every statement is tenant-scoped). Runs identically on
// hosted node-postgres and on PGlite. ENTRY POINTS: the CLI `retention:sweep`
// (the local runtime has no cron) and the `retention_sweep` graphile job. The
// hosted recurring schedule IS wired (G2b): the worker crontab fires
// `retention_sweep_all` daily at 03:00 UTC, which fans out one per-tenant job
// (jobs/retention-sweep-all-handler.ts). Local-mode users run the CLI.
//
// The TTLs come from env (MUNIN_FEEDBACK_RETENTION_DAYS /
// MUNIN_REVIEW_RETENTION_DAYS, both default 90) and are PROVISIONAL pending
// the DPO/DPIA conversation.

import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { PostgresGraphStore } from '../graph/postgres-graph-store';
import { type WriteContext, asActorId } from '../graph/types';
import { LearningStore } from '../learning/learning-store';

// A TOP-LEVEL db handle (not a tx) — the sweep owns its transaction. Both
// supported drivers expose the identical Drizzle API (see LearningStore).
export type RetentionDb = PostgresJsDatabase | PgliteDatabase;

// The ONE system identity every sweep entry point (job handler, CLI) runs as —
// the audit trail for retention must never split across drifting actor strings.
export const RETENTION_SWEEP_ACTOR = asActorId('system:retention-sweep');

// Provisional defaults pending the DPO/DPIA conversation.
export const DEFAULT_FEEDBACK_RETENTION_DAYS = 90;
export const DEFAULT_REVIEW_RETENTION_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * The feedback-content TTL in days: MUNIN_FEEDBACK_RETENTION_DAYS, default 90
 * (provisional pending the DPO conversation). Fails fast on a non-positive or
 * non-integer value — a garbled TTL must never silently widen retention.
 */
export function feedbackRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return retentionDaysFrom(env, 'MUNIN_FEEDBACK_RETENTION_DAYS', DEFAULT_FEEDBACK_RETENTION_DAYS);
}

/**
 * The resolved-review-item TTL in days: MUNIN_REVIEW_RETENTION_DAYS, default 90
 * (provisional pending the DPO conversation). Same fail-fast parsing.
 */
export function reviewRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return retentionDaysFrom(env, 'MUNIN_REVIEW_RETENTION_DAYS', DEFAULT_REVIEW_RETENTION_DAYS);
}

function retentionDaysFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  // Plain decimal digits only — Number() alone would accept '1e3'/'0x10', and a
  // retention TTL should never be spelled in scientific or hex notation.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer number of days, got '${raw}'`);
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`${name} must be a positive integer number of days, got '${raw}'`);
  }
  return days;
}

/** now − days, the boundary rows must be OLDER than to be swept. */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export interface RetentionSweepOptions {
  // Feedback rows created BEFORE this instant have their content scrubbed.
  readonly feedbackCutoff: Date;
  // RESOLVED review items reviewed BEFORE this instant have proposed_change/
  // note scrubbed (status + actors + timestamps stay — the decision trail).
  readonly reviewCutoff: Date;
}

// Content-free counts — what the audit row records and the caller reports.
export interface RetentionSweepResult {
  readonly feedbackScrubbed: number;
  readonly reviewItemsScrubbed: number;
}

/**
 * Run one tenant-scoped retention sweep: scrub expired generation_feedback
 * content in place (LearningStore.scrubExpiredFeedbackContent, F55), scrub
 * resolved review items past their TTL (GraphStore.scrubResolvedReviewItems,
 * F54 — pending items are never aged out), then write ONE content-free audit
 * row (counts + cutoffs only) — all in one transaction. Idempotent: a second
 * run over the same window scrubs nothing and still leaves an honest
 * zero-count audit row.
 */
export async function runRetentionSweep(
  db: RetentionDb,
  ctx: WriteContext,
  opts: RetentionSweepOptions,
): Promise<RetentionSweepResult> {
  // Both drivers implement the same Drizzle transaction API at runtime; the
  // narrowing is a compile-time convenience (see LearningStore's constructor).
  const dbForTx = db as PostgresJsDatabase;
  return dbForTx.transaction(async (tx) => {
    const learning = new LearningStore(tx);
    const graph = new PostgresGraphStore(tx);

    const feedbackScrubbed = await learning.scrubExpiredFeedbackContent(
      ctx.tenantId,
      opts.feedbackCutoff,
    );
    const reviewItemsScrubbed = await graph.scrubResolvedReviewItems(ctx, opts.reviewCutoff);

    await graph.recordAuditEvent(ctx, {
      action: 'retention_sweep',
      targetKind: 'tenant',
      targetId: ctx.tenantId,
      accessTagsUsed: [],
      // Counts + cutoffs only — never content.
      details: {
        feedbackScrubbed,
        feedbackCutoff: opts.feedbackCutoff.toISOString(),
        reviewItemsScrubbed,
        reviewCutoff: opts.reviewCutoff.toISOString(),
      },
    });

    return { feedbackScrubbed, reviewItemsScrubbed };
  });
}

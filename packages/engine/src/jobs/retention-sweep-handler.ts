// graphile-worker job handler for `retention_sweep` (G2a: the F55 feedback
// leg + the F54 resolved-review-item leg).
//
// Runs one tenant-scoped data-retention sweep: scrub-in-place of expired
// content with one content-free audit row, all in one transaction (see
// retention/retention-sweep.ts). The TTLs are read from the worker's
// environment at RUN time so an operator policy change applies to
// already-enqueued jobs. Idempotent — re-running scrubs nothing new.
//
// System maintenance: there is no calling user, so the audit actor is the
// shared RETENTION_SWEEP_ACTOR (one identity across the job and the CLI).

import type { Task } from 'graphile-worker';

import {
  RETENTION_SWEEP_ACTOR,
  type RetentionDb,
  feedbackRetentionDays,
  retentionCutoff,
  reviewRetentionDays,
  runRetentionSweep,
} from '../retention/retention-sweep';
import type { RetentionSweepPayload } from './job-types';

export interface RetentionSweepHandlerDeps {
  // The worker's raw Drizzle handle — the sweep spans the LearningStore and the
  // GraphStore audit writer in ONE transaction, so it needs the connection, not
  // a single store.
  readonly db: RetentionDb;
}

export function makeRetentionSweepHandler(deps: RetentionSweepHandlerDeps): Task {
  return async (payload) => {
    const { tenantId } = payload as RetentionSweepPayload;
    // This handler DESTROYS content (irreversibly, by design) — fail closed
    // explicitly on a malformed payload rather than relying on a downstream
    // FK violation to reject it.
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('retention_sweep payload requires a non-empty tenantId');
    }
    await runRetentionSweep(
      deps.db,
      { tenantId, actor: RETENTION_SWEEP_ACTOR },
      {
        feedbackCutoff: retentionCutoff(feedbackRetentionDays()),
        reviewCutoff: retentionCutoff(reviewRetentionDays()),
      },
    );
  };
}

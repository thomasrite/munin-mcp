// Data-retention sweep (G2a) — scrub-in-place past a TTL; the abstract rule is
// the durable artifact, raw content is a liability on a clock.

export {
  DEFAULT_FEEDBACK_RETENTION_DAYS,
  DEFAULT_REVIEW_RETENTION_DAYS,
  RETENTION_SWEEP_ACTOR,
  feedbackRetentionDays,
  reviewRetentionDays,
  retentionCutoff,
  runRetentionSweep,
  type RetentionDb,
  type RetentionSweepOptions,
  type RetentionSweepResult,
} from './retention-sweep';

export {
  JOB_DETECT_DUPLICATES,
  JOB_EMBED_PARAGRAPHS,
  JOB_EXTRACT_PARAGRAPHS,
  JOB_RETENTION_SWEEP,
  JOB_RETENTION_SWEEP_ALL,
  type DetectDuplicatesPayload,
  type EmbedParagraphsPayload,
  type ExtractParagraphsPayload,
  type RetentionSweepPayload,
  type RetentionSweepAllPayload,
  type JobPayloadByName,
} from './job-types';
export {
  EMBED_BATCH_SIZE,
  EXTRACT_BATCH_SIZE,
  type DedupEnqueuer,
  type EmbedEnqueuer,
  GraphileDedupEnqueuer,
  GraphileEmbedEnqueuer,
  batchForExtraction,
  batchParagraphIds,
  enqueueDetectDuplicates,
  enqueueEmbedParagraphs,
  enqueueExtractParagraphs,
  enqueueRetentionSweep,
  withWorkerUtils,
} from './enqueue';
export { makeDetectDuplicatesHandler } from './detect-duplicates-handler';
export { makeEmbedParagraphsHandler } from './embed-paragraphs-handler';
export { makeExtractParagraphsHandler } from './extract-paragraphs-handler';
export {
  makeRetentionSweepHandler,
  type RetentionSweepHandlerDeps,
} from './retention-sweep-handler';
export {
  RETENTION_SWEEP_CRONTAB,
  makeRetentionSweepAllHandler,
  type RetentionSweepAllHandlerDeps,
} from './retention-sweep-all-handler';
// In-process inline embed runner for the local/desktop runtime (P1).
export { InlineEmbedRunner, type InlineEmbedRunnerDeps } from './local-runner';
// In-process inline extraction runner for the local/desktop runtime (F44).
export {
  InlineExtractRunner,
  type InlineExtractRunnerDeps,
  type InlineExtractSummary,
} from './local-extract-runner';
export { startWorker } from './worker';

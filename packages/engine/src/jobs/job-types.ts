// Typed payloads for graphile-worker jobs.

import type { DocumentId, ParagraphId, TenantId } from '../graph/types';

export const JOB_EMBED_PARAGRAPHS = 'embed_paragraphs' as const;
export const JOB_EXTRACT_PARAGRAPHS = 'extract_paragraphs' as const;
export const JOB_DETECT_DUPLICATES = 'detect_duplicates' as const;
export const JOB_RETENTION_SWEEP = 'retention_sweep' as const;
export const JOB_RETENTION_SWEEP_ALL = 'retention_sweep_all' as const;

export interface EmbedParagraphsPayload {
  readonly tenantId: TenantId;
  readonly paragraphIds: readonly ParagraphId[];
  readonly modelId: string;
}

// Semantic-duplicate detection for one document (P3a). Enqueued after a
// document's paragraphs are embedded; the handler reads the document's vectors,
// compares centroids against nearby documents, and records semantic links.
export interface DetectDuplicatesPayload {
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
  readonly modelId: string;
}

export interface ExtractParagraphsPayload {
  readonly tenantId: TenantId;
  readonly paragraphIds: readonly ParagraphId[];
  // Configuration is loaded by the worker from its environment; the job
  // carries no schema content (configurations can be large and change).
  // The job is invalidated if the worker's configuration package or
  // version changes — operators re-extract explicitly in that case.
}

// Data-retention sweep for one tenant (G2a: F55/F54). The TTLs are read from
// the worker's environment at run time (MUNIN_*_RETENTION_DAYS), not carried in
// the payload, so an operator policy change applies to already-enqueued jobs.
export interface RetentionSweepPayload {
  readonly tenantId: TenantId;
}

// Cron coordinator (G2b): fired daily by the worker crontab; enumerates live
// tenants and enqueues one retention_sweep per tenant. No payload of our own —
// the tenant set is read from the database at fire time. (graphile-worker
// injects a `_cron: { ts, backfilled? }` member into cron-fired payloads; the
// handler ignores the payload entirely, so don't add strict validation against
// this type without accounting for that.)
export type RetentionSweepAllPayload = Record<string, never>;

export type JobPayloadByName = {
  [JOB_EMBED_PARAGRAPHS]: EmbedParagraphsPayload;
  [JOB_EXTRACT_PARAGRAPHS]: ExtractParagraphsPayload;
  [JOB_DETECT_DUPLICATES]: DetectDuplicatesPayload;
  [JOB_RETENTION_SWEEP]: RetentionSweepPayload;
  [JOB_RETENTION_SWEEP_ALL]: RetentionSweepAllPayload;
};

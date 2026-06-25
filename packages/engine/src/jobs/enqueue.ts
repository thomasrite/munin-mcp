// Job enqueue helpers used by the ingestion pipeline.
//
// graphile-worker provides `makeWorkerUtils` for enqueuing without
// running a worker. We construct one per call site; lifetime is short.

import { type WorkerUtils, makeWorkerUtils } from 'graphile-worker';

import {
  type DetectDuplicatesPayload,
  type EmbedParagraphsPayload,
  type ExtractParagraphsPayload,
  JOB_DETECT_DUPLICATES,
  JOB_EMBED_PARAGRAPHS,
  JOB_EXTRACT_PARAGRAPHS,
  JOB_RETENTION_SWEEP,
  type RetentionSweepPayload,
} from './job-types';

// Maximum paragraphs per embed_paragraphs job. Fits comfortably under
// OpenAI's 200-input batch and provides a reasonable retry granularity.
export const EMBED_BATCH_SIZE = 50;

// Maximum paragraphs per extract_paragraphs job. Smaller batch than
// embedding because each paragraph is an independent LLM call and we want
// finer-grained retry. Five paragraphs per job = five LLM calls per
// worker tick.
export const EXTRACT_BATCH_SIZE = 5;

export interface EnqueueOptions {
  readonly connectionString: string;
}

export async function withWorkerUtils<T>(
  options: EnqueueOptions,
  fn: (utils: WorkerUtils) => Promise<T>,
): Promise<T> {
  const utils = await makeWorkerUtils({ connectionString: options.connectionString });
  try {
    return await fn(utils);
  } finally {
    await utils.release();
  }
}

export async function enqueueEmbedParagraphs(
  utils: WorkerUtils,
  payload: EmbedParagraphsPayload,
): Promise<void> {
  await utils.addJob(JOB_EMBED_PARAGRAPHS, payload, {
    maxAttempts: 5,
  });
}

export async function enqueueExtractParagraphs(
  utils: WorkerUtils,
  payload: ExtractParagraphsPayload,
): Promise<void> {
  await utils.addJob(JOB_EXTRACT_PARAGRAPHS, payload, {
    maxAttempts: 5,
  });
}

export async function enqueueDetectDuplicates(
  utils: WorkerUtils,
  payload: DetectDuplicatesPayload,
): Promise<void> {
  // More attempts than embed/extract: the first attempts may fire before the
  // document's embeddings exist (the handler throws EmbeddingsNotReadyError to
  // retry), so the schedule must outlast embedding. Detection is best-effort
  // metadata — giving up after the attempts is harmless (never blocks anything).
  await utils.addJob(JOB_DETECT_DUPLICATES, payload, {
    maxAttempts: 10,
  });
}

export async function enqueueRetentionSweep(
  utils: WorkerUtils,
  payload: RetentionSweepPayload,
): Promise<void> {
  // Idempotent maintenance (scrub-in-place is marker-keyed), so retries are
  // harmless. NOTE: no recurring hosted schedule calls this yet — today's entry points are an explicit operator enqueue or the CLI.
  await utils.addJob(JOB_RETENTION_SWEEP, payload, {
    maxAttempts: 5,
  });
}

// The dedup-enqueue SEAM the ingestion pipeline uses for the semantic-duplicate
// pass — one job per ingested document. OPTIONAL (unlike embedding): when no
// enqueuer is wired, semantic detection simply does not run (e.g. the local
// single-user runtime), which never affects correctness — duplicate links are
// metadata, and the lexical near-dup pass at ingest is unaffected.
export interface DedupEnqueuer {
  enqueueAll(payloads: readonly DetectDuplicatesPayload[]): Promise<void>;
}

// Default enqueuer: hand each per-document job to graphile-worker (hosted path).
export class GraphileDedupEnqueuer implements DedupEnqueuer {
  constructor(private readonly options: EnqueueOptions) {}

  async enqueueAll(payloads: readonly DetectDuplicatesPayload[]): Promise<void> {
    if (payloads.length === 0) return;
    await withWorkerUtils(this.options, async (utils) => {
      for (const payload of payloads) {
        await enqueueDetectDuplicates(utils, payload);
      }
    });
  }
}

// The embed-enqueue SEAM the ingestion pipeline uses. Both the graphile-worker
// path (hosted: enqueue now, a separate worker process runs the handler later)
// and the in-process inline path (local/desktop runtime: run the handler logic
// synchronously now — see jobs/local-runner.ts) implement this, so the pipeline
// is backend-agnostic.
export interface EmbedEnqueuer {
  enqueueAll(payloads: readonly EmbedParagraphsPayload[]): Promise<void>;
}

// Default enqueuer: hand each batch to graphile-worker via a short-lived
// WorkerUtils (one connection for the whole run). The hosted-server path — a
// separate worker process picks the jobs up and runs them.
export class GraphileEmbedEnqueuer implements EmbedEnqueuer {
  constructor(private readonly options: EnqueueOptions) {}

  async enqueueAll(payloads: readonly EmbedParagraphsPayload[]): Promise<void> {
    if (payloads.length === 0) return;
    await withWorkerUtils(this.options, async (utils) => {
      for (const payload of payloads) {
        await enqueueEmbedParagraphs(utils, payload);
      }
    });
  }
}

// Split an arbitrary number of paragraph ids into batched jobs of size
// EMBED_BATCH_SIZE.
export function batchParagraphIds<T>(ids: readonly T[]): readonly (readonly T[])[] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += EMBED_BATCH_SIZE) {
    out.push(ids.slice(i, i + EMBED_BATCH_SIZE) as T[]);
  }
  return out;
}

export function batchForExtraction<T>(ids: readonly T[]): readonly (readonly T[])[] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += EXTRACT_BATCH_SIZE) {
    out.push(ids.slice(i, i + EXTRACT_BATCH_SIZE) as T[]);
  }
  return out;
}

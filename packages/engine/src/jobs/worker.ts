// Worker library: `startWorker`.
//
// Loads providers from env, constructs a GraphStore, registers job handlers,
// runs graphile-worker's main loop. The runnable entry point that invokes this
// lives in `munin-mcp` (`worker-cli.ts`); production (Phase 5) wires its own
// start command against this same function.
//
// graphile-worker maintains its own schema (`graphile_worker.*`). It is
// migrated automatically on `run()`.
//
// Extraction needs a Configuration to operate. The caller passes a pre-resolved
// `extractionConfiguration` (the CLI loads it from `EXTRACTION_CONFIG_PACKAGE`
// via a caller-context resolver — the engine never resolves config packages
// itself, F20). If absent, the extract_paragraphs handler is not registered —
// embedding jobs still work. This lets the worker run before a configuration is
// wired up.

import type { Configuration } from '@muninhq/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { type TaskList, run } from 'graphile-worker';
import postgres from 'postgres';

import { resolveExtractionModelId } from '../extract/extraction-model';
import { AuditedGraphStore } from '../graph/audited-graph-store';
import type { GraphStore } from '../graph/graph-store';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import { BatchedReadAuditWriter, readAuditEnabled } from '../graph/read-audit';
import { loadProvidersFromEnv } from '../providers';
import { makeDetectDuplicatesHandler } from './detect-duplicates-handler';
import { makeEmbedParagraphsHandler } from './embed-paragraphs-handler';
import { makeExtractParagraphsHandler } from './extract-paragraphs-handler';
import {
  JOB_DETECT_DUPLICATES,
  JOB_EMBED_PARAGRAPHS,
  JOB_EXTRACT_PARAGRAPHS,
  JOB_RETENTION_SWEEP,
  JOB_RETENTION_SWEEP_ALL,
} from './job-types';
import {
  RETENTION_SWEEP_CRONTAB,
  makeRetentionSweepAllHandler,
} from './retention-sweep-all-handler';
import { makeRetentionSweepHandler } from './retention-sweep-handler';

export interface WorkerStartOptions {
  readonly connectionString: string;
  readonly concurrency?: number;
  // Pre-resolved by the caller (CLI) so the engine never imports a config
  // package from its own module context (F20).
  readonly extractionConfiguration?: Configuration;
}

export async function startWorker(options: WorkerStartOptions): Promise<void> {
  const client = postgres(options.connectionString, { max: 5 });
  const db = drizzle(client);
  // Per-read audit (F10/F26): job handlers mostly read under bypass contexts
  // (logged in internal_bypass_log), but any REGULAR read a handler makes must
  // not escape the trail — so the worker wires the same audited store as the
  // web and the CLI factory.
  const rawGraphStore = new PostgresGraphStore(db);
  const readAuditWriter = readAuditEnabled() ? new BatchedReadAuditWriter(db) : null;
  const graphStore: GraphStore = readAuditWriter
    ? new AuditedGraphStore(rawGraphStore, readAuditWriter)
    : rawGraphStore;
  const providers = loadProvidersFromEnv();

  const taskList: TaskList = {
    [JOB_EMBED_PARAGRAPHS]: makeEmbedParagraphsHandler({
      graphStore,
      embeddingProvider: providers.embedding,
    }),
    [JOB_DETECT_DUPLICATES]: makeDetectDuplicatesHandler({ graphStore }),
    // Data-retention sweep (G2a) — needs the raw connection: the scrub + its
    // audit row span the LearningStore and the GraphStore in one transaction.
    [JOB_RETENTION_SWEEP]: makeRetentionSweepHandler({ db }),
    // Daily cron coordinator (G2b): fans out one retention_sweep per live
    // tenant. Hosted deployments sweep automatically via the crontab below;
    // local mode (no worker process) keeps the `retention:sweep` CLI.
    [JOB_RETENTION_SWEEP_ALL]: makeRetentionSweepAllHandler({ db }),
  };

  if (options.extractionConfiguration) {
    const configuration = options.extractionConfiguration;
    const cacheTierEnv = (process.env.EXTRACTION_CACHE_TIER ?? 'ephemeral').toLowerCase();
    const cacheTier: 'ephemeral' | 'extended' =
      cacheTierEnv === 'extended' ? 'extended' : 'ephemeral';
    // EXTRACTION_MODEL selects the extraction model; UNSET → provider default.
    const extractionModelId = resolveExtractionModelId();
    taskList[JOB_EXTRACT_PARAGRAPHS] = makeExtractParagraphsHandler({
      graphStore,
      llmProvider: providers.llm,
      configuration,
      ...(extractionModelId !== undefined ? { modelId: extractionModelId } : {}),
      cacheTier,
    });
    // Worker-bootstrap lifecycle diagnostic. Routed to stderr (console.error) — no
    // structured logger is plumbed into the engine worker library, and stderr keeps
    // stdout free for any in-process JSON-RPC (MCP) consumer of the engine.
    console.error(
      `worker registered extract_paragraphs handler with configuration ${configuration.id} v${configuration.version}, cache tier ${cacheTier}`,
    );
  } else {
    console.warn(
      'EXTRACTION_CONFIG_PACKAGE is not set — the extract_paragraphs handler is not registered; only embedding jobs will run.',
    );
  }

  const runner = await run({
    connectionString: options.connectionString,
    concurrency: options.concurrency ?? 5,
    pollInterval: 1000,
    taskList,
    // Recurring schedule (G2b): daily retention sweep at 03:00 UTC. A missed
    // firing (worker down) waits for the next day — immaterial against 90-day
    // TTLs, so no backfill window is configured.
    crontab: RETENTION_SWEEP_CRONTAB,
  });

  try {
    await runner.promise;
  } finally {
    // Drain the audit trail and release the pool even when the runner rejects —
    // a crashing worker should still land its buffered window where it can.
    if (readAuditWriter) await readAuditWriter.close();
    await client.end({ timeout: 5 });
  }
}

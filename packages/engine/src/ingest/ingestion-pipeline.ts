// Ingestion pipeline orchestrator.
//
// One entry point: `pipeline.ingest(connector, config)`. The pipeline:
//   1. Iterates the connector's stream of ConnectorRecords.
//   2. For each document: detects mime / extension, finds a parser.
//   3. Idempotency check by (tenant, sha256) — skip if seen, unless
//      forceReingest is set.
//   4. Uploads raw bytes to blob storage.
//   5. Writes the document row, parses + chunks into paragraphs, writes
//      paragraph rows (single transaction).
//   6. Enqueues embed_paragraphs jobs in batches of 50.
//   7. Logs structured results; returns a summary.

import type { BlobStorage } from '../blob';
import {
  type Connector,
  type ConnectorContext,
  type ConnectorTenantConfig,
  type DocumentSource,
  NotImplementedConnectorRecordError,
} from '../connectors';
import type { GraphStore } from '../graph/graph-store';
import {
  type DocumentId,
  type ParagraphId,
  type TenantId,
  asActorId,
  internalBypass,
  newDocumentId,
} from '../graph/types';
import {
  type DedupEnqueuer,
  type EmbedEnqueuer,
  GraphileDedupEnqueuer,
  GraphileEmbedEnqueuer,
  batchParagraphIds,
} from '../jobs/enqueue';
import { chunkBlocks } from './chunker';
import { sha256OfBytes } from './idempotency';
import { detectFromBytes, detectFromFilename } from './mime-detection';
import { type DocumentParser, ParseError, UnsupportedFormatError } from './parsers';
import { findParser } from './parsers/parser-registry';
import {
  NEAR_DUP_HAMMING_THRESHOLD,
  computeSimhash,
  hammingDistance,
  simhashSimilarity,
} from './simhash';

// Upper bound on the near-duplicate fingerprint scan per ingest. The scan is
// O(corpus) within the tenant — acceptable at pilot scale and capped here so a
// large corpus cannot make a single ingest unbounded. LSH banding to sub-linear
// is deferred until measured corpus volume justifies it.
const NEAR_DUP_SCAN_LIMIT = 5000;

export interface IngestionPipelineOptions {
  readonly graphStore: GraphStore;
  readonly blobStorage: BlobStorage;
  // Graphile-worker connection string for the default (hosted) embed-enqueue
  // path. Optional: the local runtime supplies an `embedEnqueuer` instead, which
  // runs embedding in-process with no job queue.
  readonly jobConnectionString?: string;
  readonly embeddingModelId: string;
  // Override the embed-enqueue seam. When set (e.g. the in-process InlineEmbedRunner
  // in local mode), it replaces the default graphile-worker path entirely.
  readonly embedEnqueuer?: EmbedEnqueuer;
  // Optional semantic-duplicate detection seam (P3a). When set — or when a
  // jobConnectionString is available — one detect_duplicates job is enqueued per
  // ingested document. When neither is available (e.g. local single-user mode),
  // semantic detection simply does not run; it is best-effort metadata and never
  // affects correctness. The lexical near-dup pass at ingest is independent.
  readonly dedupEnqueuer?: DedupEnqueuer;
}

export interface IngestRequest {
  readonly tenantId: TenantId;
  readonly connector: Connector;
  readonly connectorConfig: ConnectorTenantConfig;
  readonly forceReingest?: boolean;
  // Tags to attach to every ingested document and paragraph. The connector
  // could later supply per-document tags; for v1 the caller chooses.
  readonly accessTags: readonly string[];
  // OPAQUE sensitivity class id (F33) stamped on every document in this ingest.
  // The engine never interprets it (permission stays access-tag-only) — it is a
  // display/metadata field. Callers that classify per (category, sensitivity)
  // group one ingest() call per class, so a single value applies to the batch.
  readonly sensitivityClassId?: string;
}

export interface IngestSummary {
  ingested: number;
  skippedAlreadyIngested: number;
  skippedUnsupported: { count: number; samples: string[] };
  skippedNoText: { count: number; samples: string[] };
  failed: { count: number; samples: Array<{ name: string; reason: string }> };
}

export class IngestionPipeline {
  constructor(private readonly opts: IngestionPipelineOptions) {}

  async ingest(req: IngestRequest): Promise<IngestSummary> {
    const summary: IngestSummary = {
      ingested: 0,
      skippedAlreadyIngested: 0,
      skippedUnsupported: { count: 0, samples: [] },
      skippedNoText: { count: 0, samples: [] },
      failed: { count: 0, samples: [] },
    };

    const ctx: ConnectorContext = {
      tenantId: req.tenantId,
      graphStore: this.opts.graphStore,
    };

    const allParagraphIds: ParagraphId[] = [];
    const ingestedDocumentIds: DocumentId[] = [];

    for await (const record of req.connector.list(req.connectorConfig, ctx)) {
      if (record.kind !== 'document') {
        throw new NotImplementedConnectorRecordError(req.connector.packageName, record.kind);
      }
      try {
        const result = await this.ingestOne(record.document, req);
        switch (result.outcome) {
          case 'ingested':
            summary.ingested++;
            allParagraphIds.push(...result.paragraphIds);
            ingestedDocumentIds.push(result.documentId);
            break;
          case 'skipped-already':
            summary.skippedAlreadyIngested++;
            break;
          case 'skipped-unsupported':
            summary.skippedUnsupported.count++;
            if (summary.skippedUnsupported.samples.length < 5) {
              summary.skippedUnsupported.samples.push(record.document.title);
            }
            break;
          case 'skipped-no-text':
            summary.skippedNoText.count++;
            if (summary.skippedNoText.samples.length < 5) {
              summary.skippedNoText.samples.push(record.document.title);
            }
            break;
        }
      } catch (err) {
        summary.failed.count++;
        if (summary.failed.samples.length < 5) {
          summary.failed.samples.push({
            name: record.document.title,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Enqueue embedding for everything ingested, via the configured seam —
    // graphile-worker by default (hosted), or the in-process inline runner in
    // local mode.
    const payloads = batchParagraphIds(allParagraphIds).map((batch) => ({
      tenantId: req.tenantId,
      paragraphIds: batch,
      modelId: this.opts.embeddingModelId,
    }));
    await this.embedEnqueuer().enqueueAll(payloads);

    // Enqueue semantic-duplicate detection per ingested document (P3a), if a
    // dedup seam is available. Best-effort: the job retries until the document's
    // embeddings exist, then records semantic LINKS (never a merge/skip).
    const dedup = this.dedupEnqueuer();
    if (dedup && ingestedDocumentIds.length > 0) {
      await dedup.enqueueAll(
        ingestedDocumentIds.map((documentId) => ({
          tenantId: req.tenantId,
          documentId,
          modelId: this.opts.embeddingModelId,
        })),
      );
    }

    return summary;
  }

  // The embed-enqueue seam: an explicit override (local mode) wins; otherwise
  // the default graphile-worker path, which requires a job connection string.
  private embedEnqueuer(): EmbedEnqueuer {
    if (this.opts.embedEnqueuer) return this.opts.embedEnqueuer;
    if (!this.opts.jobConnectionString) {
      throw new Error(
        'IngestionPipeline requires either embedEnqueuer (local mode) or jobConnectionString (graphile-worker).',
      );
    }
    return new GraphileEmbedEnqueuer({ connectionString: this.opts.jobConnectionString });
  }

  // The dedup-enqueue seam (P3a). OPTIONAL: an explicit override wins; otherwise
  // the graphile-worker path when a job connection string is available; else
  // null — semantic detection does not run (local single-user mode), which never
  // affects correctness.
  private dedupEnqueuer(): DedupEnqueuer | null {
    if (this.opts.dedupEnqueuer) return this.opts.dedupEnqueuer;
    if (this.opts.jobConnectionString) {
      return new GraphileDedupEnqueuer({ connectionString: this.opts.jobConnectionString });
    }
    return null;
  }

  private async ingestOne(source: DocumentSource, req: IngestRequest): Promise<IngestOneResult> {
    // Detect format. Prefer the connector's mime hint; fall back to
    // extension; fall back to magic bytes after we've fetched bytes.
    const nameDetection = detectFromFilename(source.title);
    let parser: DocumentParser;
    try {
      parser = findParser({
        ...(source.mimeType ? { mimeType: source.mimeType } : {}),
        ...(nameDetection.extension ? { extension: nameDetection.extension } : {}),
      });
    } catch (err) {
      if (err instanceof UnsupportedFormatError) {
        return { outcome: 'skipped-unsupported' };
      }
      throw err;
    }

    // Now we commit to reading the bytes.
    const bytes = await source.fetchBytes();
    const sha256 = sha256OfBytes(bytes);

    // Idempotency — find existing document by hash via the GraphStore.
    if (!req.forceReingest) {
      const existing = await this.opts.graphStore.findDocumentByHash(
        {
          kind: 'bypass',
          tenantId: req.tenantId,
          bypass: internalBypass(
            'ingestion-pipeline.idempotency',
            'idempotency check by content hash before parsing',
          ),
          actor: asActorId('ingestion-pipeline'),
        },
        sha256,
      );
      if (existing) return { outcome: 'skipped-already' };
    }

    // Parse. May fail for corrupt files.
    let parsed: Awaited<ReturnType<typeof parser.parse>>;
    try {
      parsed = await parser.parse(bytes);
    } catch (err) {
      if (err instanceof ParseError) throw err;
      throw new ParseError(parser.extensions[0] ?? 'unknown', 'parser threw', err);
    }
    if (!parsed.textWasExtractable) {
      return { outcome: 'skipped-no-text' };
    }

    // Chunk
    const chunks = chunkBlocks(parsed.blocks);
    if (chunks.length === 0) return { outcome: 'skipped-no-text' };

    // Upload bytes to blob storage
    const documentId = newDocumentId();
    const blobPath = `documents/${documentId}/${sanitiseForBlobName(source.title)}`;
    const blobUri = await this.opts.blobStorage.put(req.tenantId, blobPath, bytes, {
      ...(source.mimeType ? { contentType: source.mimeType } : {}),
    });

    const detectedMime =
      source.mimeType ??
      nameDetection.mimeType ??
      detectFromBytes(bytes.slice(0, 4096)).mimeType ??
      'application/octet-stream';

    const writeCtx = { tenantId: req.tenantId, actor: asActorId('ingestion-pipeline') };

    // Near-duplicate fingerprint + bounded scan over the tenant's PRIOR
    // documents (the new row isn't inserted yet, so it is naturally excluded).
    // A near match does NOT skip or merge — the document is still fully
    // ingested below; we only record a `document_duplicates` link as metadata.
    const fingerprint = computeSimhash(chunks.map((c) => c.text).join('\n'));
    const nearMatches = await this.findNearDuplicates(req.tenantId, documentId, fingerprint);

    // Versioning: a changed document with the same (connector, externalId) as a
    // prior LIVE document is a new VERSION — we link it into the prior's version
    // group and mark the prior superseded (it stays live, demoted at query time,
    // never dropped). The exact-hash idempotency check above already returned
    // for byte-identical content, so reaching here with a prior means changed
    // content. A first version has no prior → all version fields stay null.
    const prior = await this.resolvePriorVersion(req.tenantId, req.connector.packageName, source);
    const now = new Date();

    // Write the document + paragraphs + any near-dup links + the supersession in
    // a single transaction.
    const paragraphIds: ParagraphId[] = [];
    await this.opts.graphStore.withTransaction(writeCtx, async (tx) => {
      const doc = await tx.insertDocument(writeCtx, {
        id: documentId,
        title: source.title,
        externalId: source.externalId,
        connectorPackage: req.connector.packageName,
        mimeType: detectedMime,
        byteSize: BigInt(bytes.byteLength),
        sha256,
        blobStorageUri: blobUri,
        simhash: fingerprint,
        ...(req.sensitivityClassId !== undefined
          ? { sensitivityClassId: req.sensitivityClassId }
          : {}),
        ...(source.sourceModifiedAt !== undefined
          ? { sourceModifiedAt: source.sourceModifiedAt }
          : {}),
        ...(prior
          ? {
              versionGroupId: prior.versionGroupId,
              versionSeq: prior.versionSeq,
              supersedesDocumentId: prior.priorId,
              validFrom: now,
            }
          : {}),
        accessTags: req.accessTags,
      });

      const paragraphParams = chunks.map((chunk, index) => ({
        documentId: doc.id,
        paragraphIndex: index,
        ...(chunk.structure.page !== undefined ? { page: chunk.structure.page } : {}),
        text: chunk.text,
        structure: chunk.structure,
        accessTags: req.accessTags,
      }));
      const persisted = await tx.insertParagraphsBulk(writeCtx, paragraphParams);
      for (const p of persisted) paragraphIds.push(p.id);

      // Link (never skip/merge) each near duplicate. Idempotent at the store.
      for (const match of nearMatches) {
        await tx.recordDocumentDuplicate(writeCtx, {
          documentId: doc.id,
          duplicateOfDocumentId: match.id,
          method: 'near',
          score: match.score,
        });
      }

      // Mark the prior version superseded (stays live, demoted at query time).
      if (prior) {
        await tx.supersedeDocument(writeCtx, prior.priorId, { validTo: now });
      }
    });

    return { outcome: 'ingested', documentId, paragraphIds };
  }

  // Find the prior LIVE version of this source (same connector + externalId) and
  // derive the new row's version fields. Returns null for a first version. System
  // operation → bypass, so re-ingest finds the prior regardless of tag drift
  // between ingests (mirrors the hash idempotency lookup).
  private async resolvePriorVersion(
    tenantId: TenantId,
    connectorPackage: string,
    source: DocumentSource,
  ): Promise<{ priorId: DocumentId; versionGroupId: DocumentId; versionSeq: number } | null> {
    const prior = await this.opts.graphStore.findLatestLiveDocumentByExternalId(
      {
        kind: 'bypass',
        tenantId,
        bypass: internalBypass(
          'ingestion-pipeline.versioning',
          'find the prior live version by (connector, externalId) to supersede on re-ingest',
        ),
        actor: asActorId('ingestion-pipeline'),
      },
      { connectorPackage, externalId: source.externalId },
    );
    if (!prior) return null;
    return {
      priorId: prior.id,
      // The group is the prior's group, or the prior's own id when it had none
      // (i.e. the prior was the first version of the group).
      versionGroupId: prior.versionGroupId ?? prior.id,
      versionSeq: (prior.versionSeq ?? 1) + 1,
    };
  }

  // Bounded near-duplicate scan: fetch prior fingerprints (system op → bypass,
  // so detection spans the full tenant corpus regardless of the uploader's
  // tags) and return those within the SimHash Hamming threshold. The resulting
  // links are only EXPOSED via the access-gated findDuplicatesForDocument.
  private async findNearDuplicates(
    tenantId: TenantId,
    newDocId: DocumentId,
    fingerprint: string,
  ): Promise<Array<{ id: DocumentId; score: number }>> {
    const candidates = await this.opts.graphStore.findDocumentFingerprints(
      {
        kind: 'bypass',
        tenantId,
        bypass: internalBypass(
          'ingestion-pipeline.near-dup-scan',
          'near-duplicate fingerprint scan across tenant documents before linking',
        ),
        actor: asActorId('ingestion-pipeline'),
      },
      { limit: NEAR_DUP_SCAN_LIMIT },
    );
    const matches: Array<{ id: DocumentId; score: number }> = [];
    for (const c of candidates) {
      if (c.id === newDocId) continue; // defensive: the new doc isn't inserted yet
      if (hammingDistance(fingerprint, c.simhash) <= NEAR_DUP_HAMMING_THRESHOLD) {
        matches.push({ id: c.id, score: simhashSimilarity(fingerprint, c.simhash) });
      }
    }
    return matches;
  }
}

type IngestOneResult =
  | { outcome: 'ingested'; documentId: DocumentId; paragraphIds: readonly ParagraphId[] }
  | { outcome: 'skipped-already' }
  | { outcome: 'skipped-unsupported' }
  | { outcome: 'skipped-no-text' };

function sanitiseForBlobName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

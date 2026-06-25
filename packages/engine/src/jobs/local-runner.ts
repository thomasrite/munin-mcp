// In-process inline job runner for the local/desktop runtime (P1).
//
// graphile-worker cannot run on PGlite (single connection, no cross-process
// LISTEN/NOTIFY), so local mode runs embedding work SYNCHRONOUSLY in-process,
// behind the SAME `EmbedEnqueuer` seam the ingestion pipeline uses. The logic is
// unchanged — it reuses `EmbeddingService`, exactly as the graphile
// `embed_paragraphs` handler does — only the invocation differs: immediate, in
// the calling process, with no job queue.
//
// SCALE NOTE (state it, don't engineer around it): because embedding runs
// synchronously, a large ingest BLOCKS until every batch is embedded. That is
// acceptable for a single local user (the free/local tier and the foundation
// for a desktop app); it is NOT how the hosted multi-tenant server should run,
// which is exactly why this path is opt-in (JOBS=inline) and the worker remains
// the default.

import { EmbeddingService } from '../embeddings/embedding-service';
import type { GraphStore } from '../graph/graph-store';
import type { EmbeddingProvider } from '../providers';
import type { EmbedEnqueuer } from './enqueue';
import type { EmbedParagraphsPayload } from './job-types';

export interface InlineEmbedRunnerDeps {
  readonly graphStore: GraphStore;
  readonly embeddingProvider: EmbeddingProvider;
}

export class InlineEmbedRunner implements EmbedEnqueuer {
  private readonly service: EmbeddingService;

  constructor(deps: InlineEmbedRunnerDeps) {
    this.service = new EmbeddingService(deps.embeddingProvider, deps.graphStore);
  }

  async enqueueAll(payloads: readonly EmbedParagraphsPayload[]): Promise<void> {
    for (const payload of payloads) {
      // Run the SAME work the graphile embed_paragraphs handler runs — now,
      // in-process. (payload.modelId is informational; EmbeddingService uses
      // the configured provider's model, matching the handler.)
      await this.service.embedParagraphs({
        tenantId: payload.tenantId,
        paragraphIds: payload.paragraphIds,
      });
    }
  }
}

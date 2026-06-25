// graphile-worker job handler for `embed_paragraphs`.
//
// Invoked once per job by the worker. Fetches the paragraphs (via
// INTERNAL_BYPASS — this is a system operation), calls the embedding
// service, persists embeddings via the GraphStore. Idempotent: re-running
// the same job overwrites existing embeddings under the same model id
// (driven by the embeddings_natural_key unique index).

import type { Task } from 'graphile-worker';

import { EmbeddingService } from '../embeddings/embedding-service';
import type { GraphStore } from '../graph/graph-store';
import type { EmbeddingProvider } from '../providers';
import type { EmbedParagraphsPayload } from './job-types';

export interface EmbedParagraphsHandlerDeps {
  readonly graphStore: GraphStore;
  readonly embeddingProvider: EmbeddingProvider;
}

export function makeEmbedParagraphsHandler(deps: EmbedParagraphsHandlerDeps): Task {
  const service = new EmbeddingService(deps.embeddingProvider, deps.graphStore);
  return async (payload) => {
    const { tenantId, paragraphIds } = payload as EmbedParagraphsPayload;
    await service.embedParagraphs({ tenantId, paragraphIds });
  };
}

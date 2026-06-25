// graphile-worker job handler for `detect_duplicates` (P3a).
//
// Invoked once per document after its paragraphs are embedded. Runs the
// semantic-duplicate detector, which compares the document's embedding centroid
// against nearby documents and records semantic LINKS (never a merge/skip).
//
// If the document's embeddings are not yet present (the embed job for it has not
// finished), the detector throws EmbeddingsNotReadyError — re-thrown here so
// graphile-worker retries the job (bounded attempts) once embedding completes.

import type { Task } from 'graphile-worker';

import type { GraphStore } from '../graph/graph-store';
import { SemanticDuplicateDetector } from '../ingest/semantic-dedup';
import type { DetectDuplicatesPayload } from './job-types';

export interface DetectDuplicatesHandlerDeps {
  readonly graphStore: GraphStore;
}

export function makeDetectDuplicatesHandler(deps: DetectDuplicatesHandlerDeps): Task {
  const detector = new SemanticDuplicateDetector({
    reader: deps.graphStore,
    writer: deps.graphStore,
  });
  return async (payload) => {
    const { tenantId, documentId, modelId } = payload as DetectDuplicatesPayload;
    await detector.detectForDocument({ tenantId, documentId, modelId });
  };
}

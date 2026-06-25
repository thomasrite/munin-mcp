// graphile-worker handler for `extract_paragraphs`.
//
// The worker process loads its configuration once at startup. Each job
// processes a small batch of paragraphs sequentially through the same
// Extractor instance, which means the cacheable prompt prefix is built
// once and reused across paragraphs in the batch.

import type { Task } from 'graphile-worker';

import type { Configuration } from '@muninhq/shared';

import { Extractor } from '../extract';
import type { GraphStore } from '../graph/graph-store';
import type { LLMProvider } from '../providers';
import type { ExtractParagraphsPayload } from './job-types';

export interface ExtractParagraphsHandlerDeps {
  readonly graphStore: GraphStore;
  readonly llmProvider: LLMProvider;
  readonly configuration: Configuration;
  readonly modelId?: string;
  readonly cacheTier?: 'ephemeral' | 'extended';
}

export function makeExtractParagraphsHandler(deps: ExtractParagraphsHandlerDeps): Task {
  const extractor = new Extractor({
    graphStore: deps.graphStore,
    llmProvider: deps.llmProvider,
    configuration: deps.configuration,
    ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
    ...(deps.cacheTier !== undefined ? { cacheTier: deps.cacheTier } : {}),
  });
  return async (payload) => {
    const { tenantId, paragraphIds } = payload as ExtractParagraphsPayload;
    for (const paragraphId of paragraphIds) {
      const result = await extractor.extractParagraph(tenantId, paragraphId);
      if (result.outcome === 'error') {
        // Re-throw so graphile-worker retries the job. Validation failures
        // do NOT throw — they are logged as result.outcome and the
        // paragraph is moved past.
        throw new Error(`extraction error for paragraph ${paragraphId}: ${result.errorMessage}`);
      }
    }
  };
}

// In-process inline extraction runner for the local/desktop runtime (F44).
//
// graphile-worker cannot run on PGlite (single connection, no cross-process
// LISTEN/NOTIFY), so local mode runs extraction work SYNCHRONOUSLY in-process.
// The logic is unchanged — it constructs the SAME `Extractor` the graphile
// `extract_paragraphs` handler does (ONE instance, so the cacheable prompt
// prefix is built once and reused across every batch) and walks paragraphs
// sequentially with the handler's semantics: validation failures are honest
// skips (the Extractor does one repair retry, then gives up on that
// paragraph), and only the invocation differs. Hard errors are COLLECTED per
// paragraph instead of thrown — there is no graphile to retry the job here, so
// the runner reports them in the summary and moves on rather than aborting the
// rest of the corpus.
//
// SCALE NOTE (state it, don't engineer around it): because extraction runs
// synchronously — one LLM call (two with a repair retry) per paragraph — a
// large corpus BLOCKS until every paragraph is processed. That is acceptable
// for a single local user (the free/local tier and the foundation for a
// desktop app); it is NOT how the hosted multi-tenant server should run, which
// is exactly why this path is opt-in (JOBS=inline) and the worker remains the
// default.

import type { Configuration } from '@muninhq/shared';

import { Extractor } from '../extract';
import type { GraphStore } from '../graph/graph-store';
import type { ParagraphId } from '../graph/types';
import type { LLMProvider } from '../providers';
import type { ExtractParagraphsPayload } from './job-types';

export interface InlineExtractRunnerDeps {
  readonly graphStore: GraphStore;
  readonly llmProvider: LLMProvider;
  readonly configuration: Configuration;
  readonly modelId?: string;
  readonly cacheTier?: 'ephemeral' | 'extended';
}

// Honest run accounting. `skipped` counts the non-error non-extraction
// outcomes (no-tool-call, validation-failed after repair, already-extracted
// under this extractor version); `errors` carries every hard failure with its
// paragraph so the operator can see exactly what did not land.
export interface InlineExtractSummary {
  readonly extracted: number;
  readonly skipped: number;
  readonly errors: ReadonlyArray<{ readonly paragraphId: ParagraphId; readonly message: string }>;
  readonly entitiesWritten: number;
  readonly edgesWritten: number;
  readonly repairsUsed: number;
  // F63: total top-level stringified array arguments the validation shim
  // parse-substituted across the run (see validateExtractionOutput).
  readonly stringifiedArraysParsed: number;
}

export class InlineExtractRunner {
  private readonly extractor: Extractor;

  constructor(deps: InlineExtractRunnerDeps) {
    this.extractor = new Extractor({
      graphStore: deps.graphStore,
      llmProvider: deps.llmProvider,
      configuration: deps.configuration,
      ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
      ...(deps.cacheTier !== undefined ? { cacheTier: deps.cacheTier } : {}),
    });
  }

  async run(batches: ReadonlyArray<ExtractParagraphsPayload>): Promise<InlineExtractSummary> {
    let extracted = 0;
    let skipped = 0;
    let entitiesWritten = 0;
    let edgesWritten = 0;
    let repairsUsed = 0;
    let stringifiedArraysParsed = 0;
    const errors: Array<{ paragraphId: ParagraphId; message: string }> = [];

    for (const batch of batches) {
      for (const paragraphId of batch.paragraphIds) {
        // The SAME work the graphile extract_paragraphs handler runs — now,
        // in-process.
        const result = await this.extractor.extractParagraph(batch.tenantId, paragraphId);
        if (result.repairUsed) repairsUsed++;
        stringifiedArraysParsed += result.stringifiedArraysParsed;
        if (result.outcome === 'extracted') {
          extracted++;
          entitiesWritten += result.entitiesWritten;
          edgesWritten += result.edgesWritten;
        } else if (result.outcome === 'error') {
          errors.push({
            paragraphId,
            message: result.errorMessage ?? 'unknown extraction error',
          });
        } else {
          skipped++;
        }
      }
    }

    return {
      extracted,
      skipped,
      errors,
      entitiesWritten,
      edgesWritten,
      repairsUsed,
      stringifiedArraysParsed,
    };
  }
}

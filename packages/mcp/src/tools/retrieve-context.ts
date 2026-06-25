// munin_retrieve_context — THE HEADLINE TOOL.
//
// Returns ranked, permission-filtered, cited context for a question; the
// CALLING LLM does the synthesis. Costs one embedding call on this side — no
// answer-model spend. Routed through the engine's single context seam
// (ContextRetriever.retrieveContext) under the single-user context.

import {
  COUNT_DECLINE_MESSAGE,
  type GroundedContext,
  isAggregationQuestion,
} from '@muninhq/engine';

import { buildIdentity } from '../identity';
import { SOURCES_CITATION_GUIDANCE } from './citation-guidance';
import {
  type ShapedDisambiguation,
  type ShapedSource,
  completenessBanner,
  shapeDisambiguation,
  shapeSource,
} from './shaping';
import type { ToolDeps } from './types';

export interface RetrieveContextInput {
  readonly question: string;
  readonly subject?: string;
}

export interface RetrievedContext {
  readonly status: 'context';
  readonly method: string;
  readonly subject: string | null;
  readonly sources: readonly ShapedSource[];
  /** Honest gather-path completeness note; null on the open path. */
  readonly completenessNote: string | null;
  /** Stable instruction: answer only from these sources and cite each one's citeAs token inline. */
  readonly citationGuidance: string;
}

export interface AggregationUnsupported {
  readonly status: 'aggregation_unsupported';
  /** Honest decline (mirrors the Q&A path's COUNT_DECLINE_MESSAGE) — no countable window. */
  readonly note: string;
}

export type RetrieveContextResult =
  | RetrievedContext
  | ShapedDisambiguation
  | AggregationUnsupported;

/**
 * Honest counting on the retrieval surface: a top-k window cannot enumerate a
 * whole corpus, so returning ranked sources for a "how many …" question invites
 * the client to miscount them into a confidently-wrong total. The Q&A path
 * (munin_ask) already declines these; mirror that here. Reuses the pipeline's
 * COUNT_DECLINE_MESSAGE so the wording stays in lockstep, and adds why no window
 * is returned (any sample would be partial).
 */
export const RETRIEVE_CONTEXT_AGGREGATION_NOTE = `${COUNT_DECLINE_MESSAGE} (Any paragraphs retrieved for a count would be only a top-ranked partial sample, never the full set, so no window is returned here — counting them would give a wrong total.)`;

/**
 * When the caller names a subject explicitly, fold it into the question text:
 * classification routes on name-mention, and the embedding should carry the
 * subject too. Otherwise the question is used verbatim.
 */
export function effectiveQuestion(input: RetrieveContextInput): string {
  const subject = input.subject?.trim();
  if (!subject) return input.question;
  if (input.question.toLowerCase().includes(subject.toLowerCase())) return input.question;
  return `${input.question} (about ${subject})`;
}

export async function retrieveContext(
  deps: ToolDeps,
  input: RetrieveContextInput,
): Promise<RetrieveContextResult> {
  // Decline counting/aggregation before retrieval (no embedding spend): a top-k
  // window is not a corpus census. Consistent with munin_ask's same guard.
  if (isAggregationQuestion(input.question)) {
    return { status: 'aggregation_unsupported', note: RETRIEVE_CONTEXT_AGGREGATION_NOTE };
  }

  const result: GroundedContext = await deps.retriever.retrieveContext(deps.context, {
    question: effectiveQuestion(input),
    identity: buildIdentity(deps.configuration),
  });

  if (result.kind === 'disambiguation') {
    // retrieve_context has no `pick` argument, so resolve via munin_gather_entity:
    // it returns the same self-synthesis sources and accepts a pick token.
    return shapeDisambiguation(
      result.subject,
      result.group,
      result.pickWasStale,
      'munin_gather_entity',
    );
  }

  return {
    status: 'context',
    method: result.method,
    subject: result.subject,
    sources: result.sources.map(shapeSource),
    completenessNote: result.completeness
      ? completenessBanner(result.completeness.subject, result.completeness.mayHaveUnlinkedRecords)
      : null,
    citationGuidance: SOURCES_CITATION_GUIDANCE,
  };
}

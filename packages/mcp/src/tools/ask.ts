// munin_ask — the full grounded answer path: a grounded answer with [n]-keyed
// citations, or an HONEST 'no_evidence' verbatim. Never softened: a fail-closed
// no_evidence is the contract, not an error. This is the STRONGEST-grounding
// surface — synthesis and the no_evidence contract run server-side.
//
// Two routes, chosen by whether the caller named a subject:
//   • OPEN (no subject/pick) → QueryPipeline.answer: the open vector path, which
//     keeps its own honest-counting guard and records query telemetry. Byte-for-
//     byte the prior behaviour, plus the additive citeAs token.
//   • ENTITY-ROUTED (subject or pick) → the engine's identity seam
//     (ContextRetriever.retrieveContext with the configuration's identity layer)
//     then QueryPipeline.answerFromContext over the gathered set — the same
//     resolve → gather → answer route the web ask path uses, composed here from
//     the FROZEN engine surface (no engine change). A same-name collision surfaces
//     as a 'disambiguation' result; a gather carries an honest completeness note.

import { COUNT_DECLINE_MESSAGE, asActorId, isAggregationQuestion } from '@muninhq/engine';

import { MCP_ACTOR } from '../context';
import { buildIdentity } from '../identity';
import { ASK_CITATION_GUIDANCE } from './citation-guidance';
import { effectiveQuestion } from './retrieve-context';
import { type ShapedDisambiguation, computeCiteAs, shapeDisambiguation } from './shaping';
import type { ToolDeps } from './types';

export interface AskInput {
  readonly question: string;
  /** Optional subject name to route the answer through the identity layer. */
  readonly subject?: string;
  /** A candidate pick token from a previous disambiguation result. */
  readonly pick?: string;
}

export interface AskCitation {
  /** The [n] marker appearing in the answer text. */
  readonly marker: number;
  readonly documentId: string;
  readonly paragraphId: string;
  readonly quote: string;
  /**
   * Stable cross-call/cross-tool citation token (see `computeCiteAs`). The SAME
   * token the source-returning tools mint, so a source cited here unifies with
   * one cited via munin_retrieve_context / munin_gather_entity in one conversation.
   */
  readonly citeAs: string;
}

export interface AskAnswer {
  readonly status: 'answered' | 'no_evidence';
  readonly answer: string;
  readonly citations: readonly AskCitation[];
  /** The subject the answer was gathered by, when entity-routed; absent on the open path. */
  readonly subject?: string | null;
  /** Honest gather completeness note when entity-routed; absent on the open path. */
  readonly completenessNote?: string | null;
  /** Stable instruction telling the caller to preserve [n] markers / honour no_evidence. */
  readonly citationGuidance: string;
}

export type AskResult = AskAnswer | ShapedDisambiguation;

function shapeCitations(
  citations: readonly { marker: number; documentId: string; paragraphId: string; quote: string }[],
): AskCitation[] {
  return citations.map((c) => ({
    marker: c.marker,
    documentId: c.documentId,
    paragraphId: c.paragraphId,
    quote: c.quote,
    citeAs: computeCiteAs(c.documentId, c.paragraphId),
  }));
}

export async function ask(deps: ToolDeps, input: AskInput): Promise<AskResult> {
  const subject = input.subject?.trim();
  const pick = input.pick?.trim();

  // OPEN path (no subject/pick): unchanged — QueryPipeline.answer carries its own
  // honest-counting guard and query telemetry. Only the citeAs token is added.
  if (!subject && !pick) {
    const result = await deps.pipeline.answer({
      tenantId: deps.tenantId,
      accessTags: deps.context.accessTags,
      question: input.question,
      actor: asActorId(MCP_ACTOR),
    });
    return {
      status: result.status,
      answer: result.answer,
      citations: shapeCitations(result.citations),
      citationGuidance: ASK_CITATION_GUIDANCE,
    };
  }

  // ENTITY-ROUTED path. answerFromContext has no built-in count guard (only
  // QueryPipeline.answer does), so apply the SAME honest-counting decline here to
  // keep counting consistent across both routes (mirrors retrieve_context). Unlike
  // the open path's in-pipeline decline, this one records no query_events row — an
  // accepted asymmetry; the MCP tier never owned answer telemetry separately.
  if (isAggregationQuestion(input.question)) {
    return {
      status: 'no_evidence',
      answer: COUNT_DECLINE_MESSAGE,
      citations: [],
      subject: null,
      completenessNote: null,
      citationGuidance: ASK_CITATION_GUIDANCE,
    };
  }

  const context = await deps.retriever.retrieveContext(deps.context, {
    question: effectiveQuestion({ question: input.question, ...(subject ? { subject } : {}) }),
    identity: buildIdentity(deps.configuration, pick),
  });

  // Several distinct subjects share the name → surface the candidates (the SAME
  // shape munin_retrieve_context / munin_gather_entity return); the client re-calls
  // with the chosen candidate's pick token.
  if (context.kind === 'disambiguation') {
    // Keep the client on munin_ask (the server-enforced path) to resolve the pick.
    return shapeDisambiguation(context.subject, context.group, context.pickWasStale, 'munin_ask');
  }

  // Open or gather context → ground + answer over exactly that set. The engine
  // attaches a completeness disposition on the gather path; the open path (subject
  // did not resolve) carries none. Pass the read context so the contradiction pass
  // can enrich cited document metadata under the SAME access filter.
  const result = await deps.pipeline.answerFromContext(
    { tenantId: deps.tenantId, actor: asActorId(MCP_ACTOR), readContext: deps.context },
    context,
  );

  return {
    status: result.status,
    answer: result.answer,
    citations: shapeCitations(result.citations),
    subject: context.subject,
    completenessNote: result.completeness?.note ?? null,
    citationGuidance: ASK_CITATION_GUIDANCE,
  };
}

// QueryPipeline — the engine's grounded question-answering read path. It is
// "ContextRetriever + grounding + answer": retrieval is delegated to the
// ContextRetriever seam (the single, reusable, permission-correct context
// surface); this class owns the LLM synthesis on top of it.
//
//   retrieve context (ContextRetriever):
//     embed → vector search (tenant + access-tag filtered) → materialise →
//     depth-1 graph expansion → select/budget the grounding set
//   then here:
//     → ground + answer (Claude, forced tool_use, Opus)
//     → parse + resolve citations (reject any not in the visible grounding set)
//
// `answer` is the open-question entry (no identity layer → vector path);
// `answerFromContext` grounds over a context the caller retrieved itself (the
// web ask path, which supplies the configuration's identity layer to route
// entity-centric questions through gather). Vertical-agnostic throughout: no
// entity-type names, no edge-type knowledge, no domain terms.

import type { AuthorityPolicy } from '@muninhq/shared';

import type { GraphStore } from '../graph/graph-store';
import {
  type ActorId,
  type Paragraph,
  type QueryEventStatus,
  type ReadContext,
  type TenantId,
  asActorId,
} from '../graph/types';
import type {
  EmbeddingProvider,
  LLMProvider,
  ProviderCallContext,
  RerankProvider,
} from '../providers';
import { COUNT_DECLINE_MESSAGE, isAggregationQuestion } from './aggregation-guard';
import { ANSWER_TOOL_NAME, NO_EVIDENCE_MESSAGE, assembleAnswerPrompt } from './answer-prompt';
import { ContextRetriever, type GroundedContext } from './context-retriever';
import {
  adjudicateConflicts,
  parseContradictionInput,
  renderContradictionUserMessage,
  validateConflicts,
} from './contradiction';
import { CONTRADICTION_TOOL_NAME, assembleContradictionPrompt } from './contradiction-prompt';
import { verifyQuoteGrounding } from './faithfulness';
import { type GroundedSource, type GroundingCandidate, buildGroundingContext } from './grounding';
import { reconcileMarkers } from './marker-reconcile';
import { SENTENCE_END_RE } from './query-auditor';
import type { AnswerCompleteness, Citation, QueryRequest, QueryResult } from './types';

// The grounded-context arm (open or gather). `retrieveContext` may also return a
// disambiguation signal; only the context arm carries sources to ground over.
type ContextArm = Extract<GroundedContext, { kind: 'context' }>;

const ACTOR: ActorId = asActorId('system:query-pipeline');

// Answer-synthesis model. Reads ANSWER_MODEL (default Sonnet — Opus is not
// enabled on the Bedrock account; flip ANSWER_MODEL to 'claude-opus-4-7' to
// compare cost/quality once access is granted). Per-call override via
// opts.model still wins. Env read, not a prompt/retrieval change.
const DEFAULT_ANSWER_MODEL = process.env.ANSWER_MODEL?.trim() || 'claude-sonnet-4-6';

// Contradiction-detection model (P3b). A CHEAP model — this is detection, not
// synthesis — so it defaults to Haiku and never the answer model. Env-overridable
// (CONTRADICTION_MODEL), like ANSWER_MODEL; per-call/option override still wins.
const DEFAULT_CONTRADICTION_MODEL =
  process.env.CONTRADICTION_MODEL?.trim() || 'claude-haiku-4-5-20251001';

// Output cap for the detection call. Conflicts are short structured summaries, so
// a modest ceiling is plenty; a truncated detection just yields fewer/no conflicts
// (the answer is unaffected).
const CONTRADICTION_MAX_OUTPUT_TOKENS = 1024;

export interface QueryPipelineOptions {
  readonly graphStore: GraphStore;
  readonly llmProvider: LLMProvider;
  readonly embeddingProvider: EmbeddingProvider;
  // Answer-synthesis model. Defaults to Opus.
  readonly model?: string;
  // Vector search breadth (top-k). Default 20.
  readonly k?: number;
  // Max paragraphs admitted to the grounding prompt. Default 12.
  readonly maxParagraphs?: number;
  // Cosine-distance cutoff for vector hits. Default 0.6.
  readonly distanceThreshold?: number;
  // Token ceiling for the grounding sources. Default 6000.
  readonly tokenCeiling?: number;
  // Per-entity neighbour cap during expansion. Default 25.
  readonly expansionBreadth?: number;
  // Hybrid blend weight on the keyword/lexical path (open path). 0 = vector-only,
  // 1 = keyword-only. Default ≈0.4 (≈60/40 semantic/keyword). Forwarded to the
  // ContextRetriever.
  readonly keywordWeight?: number;
  // Keyword search breadth. Defaults to `k`.
  readonly keywordK?: number;
  // Recency decay half-life in days for the open ranking path. Undefined ⇒ off.
  // Forwarded to the ContextRetriever.
  readonly recencyHalfLifeDays?: number;
  // Multiplier on the open-path score of superseded document versions (default
  // 0.5 in the ContextRetriever; 1 disables). Forwarded to the ContextRetriever.
  readonly supersededDemotionFactor?: number;
  // Output token cap for the answer. Default 1500.
  readonly maxOutputTokens?: number;
  // Optional reranker for the open path (forwarded to the ContextRetriever).
  readonly rerankProvider?: RerankProvider;
  readonly rerankCandidates?: number;
  // P3b "sources disagree" pass. When true (the default), an ANSWERED result
  // whose citations span ≥2 distinct documents gets one cheap (Haiku) detection
  // call that may attach a `contradictions` annotation. Set false to disable.
  // Purely additive — never alters the answer text or the fail-closed path.
  readonly contradictionDetection?: boolean;
  // OPAQUE authority ordering for contradiction adjudication (config-supplied).
  // The engine ranks a document by the first matching access-tag token; it never
  // interprets the tokens. Absent ⇒ adjudicate by recency/validity only.
  readonly authorityPolicy?: AuthorityPolicy;
  // Detection model override (default Haiku via CONTRADICTION_MODEL env).
  readonly contradictionModel?: string;
}

interface ResolvedOptions {
  readonly model: string;
  readonly k: number;
  readonly maxParagraphs: number;
  readonly distanceThreshold: number;
  readonly tokenCeiling: number;
  readonly expansionBreadth: number;
  readonly maxOutputTokens: number;
  readonly contradictionDetection: boolean;
  readonly contradictionModel: string;
}

// One source paragraph for the entity-centric answer path (the gathered set).
// Mirrors a GroundingCandidate without a vector distance — these are the
// subject's records, included structurally, not by similarity.
export interface AnswerSource {
  readonly paragraph: Paragraph;
  readonly documentTitle?: string;
}

// The gather's completeness, as the caller computed it (from gatherByIdentity).
// `recordCount` is visible-scoped; `mayHaveUnlinkedRecords` true → the answer is
// banner-flagged as possibly incomplete (and NAMES the subject).
export interface AnswerOverSourcesRequest {
  readonly tenantId: TenantId;
  readonly question: string;
  // The named subject the gathered set is about (for the specific banner).
  readonly subject: string;
  readonly sources: readonly AnswerSource[];
  readonly completeness: { readonly mayHaveUnlinkedRecords: boolean; readonly recordCount: number };
  readonly actor?: ActorId;
}

export class QueryPipeline {
  private readonly cfg: ResolvedOptions;
  // The retrieval seam. The pipeline is "ContextRetriever + grounding + answer":
  // it owns the LLM synthesis; all retrieval (open vector + entity gather) goes
  // through this one surface.
  private readonly retriever: ContextRetriever;

  constructor(private readonly opts: QueryPipelineOptions) {
    this.cfg = {
      model: opts.model ?? DEFAULT_ANSWER_MODEL,
      k: opts.k ?? 20,
      maxParagraphs: opts.maxParagraphs ?? 12,
      distanceThreshold: opts.distanceThreshold ?? 0.6,
      tokenCeiling: opts.tokenCeiling ?? 6000,
      expansionBreadth: opts.expansionBreadth ?? 25,
      maxOutputTokens: opts.maxOutputTokens ?? 1500,
      // Default ON — a caller (config) must opt OUT explicitly.
      contradictionDetection: opts.contradictionDetection ?? true,
      contradictionModel: opts.contradictionModel ?? DEFAULT_CONTRADICTION_MODEL,
    };
    this.retriever = new ContextRetriever({
      graphStore: opts.graphStore,
      embeddingProvider: opts.embeddingProvider,
      k: this.cfg.k,
      maxParagraphs: this.cfg.maxParagraphs,
      distanceThreshold: this.cfg.distanceThreshold,
      tokenCeiling: this.cfg.tokenCeiling,
      expansionBreadth: this.cfg.expansionBreadth,
      // Forward the hybrid + recency knobs (undefined → ContextRetriever defaults).
      ...(opts.keywordWeight !== undefined ? { keywordWeight: opts.keywordWeight } : {}),
      ...(opts.keywordK !== undefined ? { keywordK: opts.keywordK } : {}),
      ...(opts.recencyHalfLifeDays !== undefined
        ? { recencyHalfLifeDays: opts.recencyHalfLifeDays }
        : {}),
      ...(opts.supersededDemotionFactor !== undefined
        ? { supersededDemotionFactor: opts.supersededDemotionFactor }
        : {}),
      ...(opts.rerankProvider ? { rerankProvider: opts.rerankProvider } : {}),
      ...(opts.rerankCandidates !== undefined ? { rerankCandidates: opts.rerankCandidates } : {}),
    });
  }

  // Public entry: run the query and record one query_events telemetry row for
  // EVERY outcome (D2) — answered, no_evidence, AND error (provider/DB failure)
  // — measuring end-to-end latency. The actor comes from the request (web user /
  // cli) and defaults to the pipeline's system actor.
  async answer(req: QueryRequest): Promise<QueryResult> {
    const actor = req.actor ?? ACTOR;
    const start = Date.now();
    let result: QueryResult;
    try {
      result = await this.computeAnswer(req, actor);
    } catch (err) {
      // Record the failure outcome, then propagate the original error.
      await this.recordQueryEvent(req.tenantId, actor, 'error', 0, Date.now() - start);
      throw err;
    }
    await this.recordOutcome(req.tenantId, actor, result, Date.now() - start);
    return result;
  }

  // Telemetry is best-effort: a failed query_events write must never fail (or
  // clobber) an answer that was already produced. Swallow write errors.
  private async recordQueryEvent(
    tenantId: TenantId,
    actor: ActorId,
    status: QueryEventStatus,
    resultCount: number,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.opts.graphStore.insertQueryEvent(
        { tenantId, actor },
        { actor, status, resultCount, latencyMs },
      );
    } catch {
      // Intentionally swallowed — telemetry is never on the answer's critical path.
    }
  }

  // Record BOTH telemetry signals for a finished answer: the query_events row
  // (one per outcome) and one citation_events row per surviving citation (the
  // implicit-feedback / learning-loop seed). Both best-effort; never block the answer.
  private async recordOutcome(
    tenantId: TenantId,
    actor: ActorId,
    result: QueryResult,
    latencyMs: number,
  ): Promise<void> {
    await this.recordQueryEvent(tenantId, actor, result.status, result.citations.length, latencyMs);
    await this.recordCitationEvents(tenantId, actor, result.citations);
  }

  // One content-free citation_events row per surviving (grounded) citation — the
  // implicit "this source was useful" signal. Best-effort like query_events.
  private async recordCitationEvents(
    tenantId: TenantId,
    actor: ActorId,
    citations: readonly Citation[],
  ): Promise<void> {
    if (citations.length === 0) return;
    try {
      await this.opts.graphStore.insertCitationEvents(
        { tenantId, actor },
        citations.map((c) => ({ paragraphId: c.paragraphId, documentId: c.documentId })),
      );
    } catch {
      // Intentionally swallowed — telemetry is never on the answer's critical path.
    }
  }

  private async computeAnswer(req: QueryRequest, actor: ActorId): Promise<QueryResult> {
    // Honest counting: a count/aggregation question cannot be answered reliably
    // from a top-k retrieval window (records outside it are never seen), so decline
    // honestly instead of emitting a confidently-wrong number. Generic guard.
    if (isAggregationQuestion(req.question)) {
      return { status: 'no_evidence', answer: COUNT_DECLINE_MESSAGE, citations: [] };
    }

    const readCtx: ReadContext = {
      kind: 'regular',
      tenantId: req.tenantId,
      accessTags: req.accessTags,
      actor,
    };

    // Retrieval delegates to the ContextRetriever seam. With no identity layer
    // this is exactly the open vector path (embed → search → expand → budget) —
    // QueryPipeline.answer stays the open-question entry; the entity routing is
    // for callers that hold a configuration (the web, via retrieveContext).
    const context = await this.retriever.retrieveContext(readCtx, { question: req.question });
    // Defensive: with no identity, retrieveContext only ever returns the context
    // arm (never a disambiguation). A non-context arm has no sources to ground.
    if (context.kind !== 'context') return this.noEvidence();
    // Pass the read context so the (answered, multi-doc) contradiction pass can
    // enrich already-cited document metadata under the SAME access filter.
    return this.answerFromContextArm(req.tenantId, context, readCtx);
  }

  // Ground + answer over an already-retrieved GroundedContext, recording one
  // query_events row for every outcome (answered / no_evidence / error) — the
  // entry point for callers that drive the ContextRetriever themselves (the web
  // ask path) so they need not re-run retrieval to synthesise an answer.
  async answerFromContext(
    req: {
      readonly tenantId: TenantId;
      readonly actor?: ActorId;
      // The caller's read context (P3b). When supplied AND contradiction detection
      // is enabled, an answered multi-document result may carry a `contradictions`
      // annotation — the pass enriches already-cited document metadata under THIS
      // same access filter (no new retrieval). Omitted ⇒ the pass is skipped and
      // the result is byte-identical to before P3b.
      readonly readContext?: ReadContext;
    },
    context: ContextArm,
  ): Promise<QueryResult> {
    const actor = req.actor ?? ACTOR;
    const start = Date.now();
    let result: QueryResult;
    try {
      result = await this.answerFromContextArm(req.tenantId, context, req.readContext);
    } catch (err) {
      await this.recordQueryEvent(req.tenantId, actor, 'error', 0, Date.now() - start);
      throw err;
    }
    await this.recordOutcome(req.tenantId, actor, result, Date.now() - start);
    return result;
  }

  // Shared core: ground over the context's sources and synthesise. The gather
  // path carries a completeness disposition (specific banner); the open path
  // does not (the engine never asserts completeness it did not earn).
  private async answerFromContextArm(
    tenantId: TenantId,
    context: ContextArm,
    readContext?: ReadContext,
  ): Promise<QueryResult> {
    const callCtx: ProviderCallContext = {
      tenantId,
      purpose: 'query',
      graphStore: this.opts.graphStore,
    };
    // `context.sources` IS the grounding-admitted (capped) set on the gather path,
    // while `context.completeness.recordCount` is the full gathered total — so its
    // length is the like-for-like `admitted` count for the truncation guard.
    const completeness = context.completeness
      ? buildCompleteness(context.completeness.subject, {
          mayHaveUnlinkedRecords: context.completeness.mayHaveUnlinkedRecords,
          recordCount: context.completeness.recordCount,
          admitted: context.sources.length,
        })
      : undefined;
    // Mechanical floor: no visible evidence → decline without an LLM call. (On
    // the gather path we still report the completeness disposition honestly.)
    if (context.message === null) return this.noEvidence(completeness);
    return this.groundAndAnswer(
      context.message,
      context.sources,
      callCtx,
      completeness,
      readContext,
    );
  }

  // Entity-centric answer path (G1 / F31). The caller has already resolved the
  // subject and GATHERED its records; it passes the gathered paragraphs as the
  // grounding set (instead of vector top-k) plus the gather's completeness. We
  // ground + answer over exactly that set and attach a SPECIFIC completeness
  // banner. Fail-closed citations are preserved unchanged (same resolve()).
  //
  // NOTE: the ContextRetriever-integrated path is `answerFromContext` — it takes a
  // GroundedContext the caller already retrieved (open OR gather) and is what the
  // web ask path now uses. `answerOverSources` is the lower-level API for callers
  // that materialised the gathered source set themselves; it remains a tested,
  // public entry (it does its own buildGroundingContext over caller-supplied sources).
  //
  // THE INVARIANT (acceptance bar 2): completeness is asserted ONLY here, where a
  // real gather happened — never on the open vector path. So no answer is ever
  // both incomplete and unbanned: an entity-centric answer always carries the
  // disposition (complete, or a specific "may be incomplete" note).
  //
  // Records ONE query_events row for every outcome, exactly like answer().
  async answerOverSources(req: AnswerOverSourcesRequest): Promise<QueryResult> {
    const actor = req.actor ?? ACTOR;
    const start = Date.now();
    let result: QueryResult;
    try {
      result = await this.computeAnswerOverSources(req);
    } catch (err) {
      await this.recordQueryEvent(req.tenantId, actor, 'error', 0, Date.now() - start);
      throw err;
    }
    await this.recordOutcome(req.tenantId, actor, result, Date.now() - start);
    return result;
  }

  private async computeAnswerOverSources(req: AnswerOverSourcesRequest): Promise<QueryResult> {
    const callCtx: ProviderCallContext = {
      tenantId: req.tenantId,
      purpose: 'query',
      graphStore: this.opts.graphStore,
    };

    // Build candidates from the caller-supplied (gathered) paragraphs. No vector
    // distance — these earned inclusion structurally (they ARE the subject's
    // records), so they are exempt from the distance threshold, like expansion.
    const candidates: GroundingCandidate[] = req.sources.map((s) => ({
      paragraph: s.paragraph,
      distance: null,
      ...(s.documentTitle !== undefined ? { documentTitle: s.documentTitle } : {}),
    }));
    const grounding = buildGroundingContext(req.question, candidates, {
      distanceThreshold: this.cfg.distanceThreshold,
      maxParagraphs: this.cfg.maxParagraphs,
      tokenCeiling: this.cfg.tokenCeiling,
    });

    // The completeness disposition is computed from the GATHER — independent of
    // whether the model finds anything to say, so a no_evidence result still
    // honestly reports that we gathered N records. It is computed AFTER grounding
    // so it can see how many of the gathered records actually reached the prompt
    // (`grounding.sources.length`): if the window truncated the gathered set, the
    // answer is NOT complete even when no records were unlinked.
    const completeness = buildCompleteness(req.subject, {
      mayHaveUnlinkedRecords: req.completeness.mayHaveUnlinkedRecords,
      recordCount: req.completeness.recordCount,
      admitted: grounding.sources.length,
    });
    // No visible gathered evidence → honest no_evidence, but STILL banded: the
    // disposition reports we gathered the subject's (zero, or unlinked) records.
    if (grounding.message === null) return this.noEvidence(completeness);

    return this.groundAndAnswer(grounding.message, grounding.sources, callCtx, completeness);
  }

  // --- internals ----------------------------------------------------------

  // Shared ground + answer + resolve. The system + tool form the cacheable static
  // prefix; the tenant paragraph snippets live ONLY in the user message (F4).
  private async groundAndAnswer(
    message: string,
    sources: readonly GroundedSource[],
    callCtx: ProviderCallContext,
    completeness?: AnswerCompleteness,
    readContext?: ReadContext,
  ): Promise<QueryResult> {
    const prompt = assembleAnswerPrompt();
    const response = await this.opts.llmProvider.complete(
      {
        model: this.cfg.model,
        system: prompt.system,
        messages: [{ role: 'user', content: message }],
        cacheableSystemPrefix: true,
        tools: [prompt.tool],
        toolChoice: { type: 'tool', name: prompt.toolName },
        maxOutputTokens: this.cfg.maxOutputTokens,
      },
      callCtx,
    );
    // The fail-closed answer is assembled here and is NEVER mutated past this
    // point. The P3b pass is purely ADDITIVE: it may attach a `contradictions`
    // annotation to an answered, multi-document result, and is a no-op otherwise.
    const result = this.resolve(response.toolCalls, sources, completeness);
    return this.maybeAttachContradictions(result, sources, callCtx, readContext);
  }

  // P3b — surface honest source disagreement WITHOUT touching the grounded answer.
  // Runs only AFTER the answered QueryResult is assembled, only over the already-
  // retrieved, already-permission-filtered, already-grounded citations. Every gate
  // below short-circuits to the unchanged `result` (and, before the answered/≥2-doc
  // gates, makes NO LLM call) — so a no_evidence result, a single-document answer,
  // or a disabled toggle is byte-identical to pre-P3b behaviour.
  private async maybeAttachContradictions(
    result: QueryResult,
    sources: readonly GroundedSource[],
    callCtx: ProviderCallContext,
    readContext?: ReadContext,
  ): Promise<QueryResult> {
    // Gate 1 — answered only. no_evidence makes NO contradiction LLM call.
    if (result.status !== 'answered') return result;
    // Gate 2 — config toggle (default on).
    if (!this.cfg.contradictionDetection) return result;
    // Gate 3 — a read context is required to enrich already-cited document
    // metadata (recency/validity/authority). Without one we cannot adjudicate, so
    // skip (callers that don't supply it stay byte-identical).
    if (!readContext) return result;
    // Gate 4 — at least two DISTINCT cited documents; nothing to compare otherwise.
    const distinctDocs = [...new Set(result.citations.map((c) => c.documentId))];
    if (distinctDocs.length < 2) return result;

    try {
      // Detect (cheap LLM) → validate to existing markers (fail-closed) → only
      // then fetch document metadata + adjudicate deterministically.
      const raw = await this.detectContradictions(result, sources, callCtx);
      const validated = validateConflicts(raw, result.citations);
      if (validated.length === 0) return result;
      // Enrichment, NOT new retrieval: metadata for the documents already cited
      // (and already visible to the caller), under the caller's own access filter.
      const docs = await this.opts.graphStore.getDocumentsByIds(readContext, distinctDocs);
      const contradictions = adjudicateConflicts(
        validated,
        result.citations,
        docs,
        this.opts.authorityPolicy,
      );
      if (contradictions.length === 0) return result;
      return { ...result, contradictions };
    } catch {
      // Best-effort, exactly like the telemetry writes: a detection failure must
      // NEVER fail or alter an answer that already succeeded. Return it unchanged.
      return result;
    }
  }

  // One cheap (Haiku) constrained tool call over the grounded answer + cited
  // source snippets. F4: the system+tool prefix is static/tenant-free
  // (cacheableSystemPrefix: true); the answer + sources ride only in the user turn.
  private async detectContradictions(
    result: QueryResult,
    sources: readonly GroundedSource[],
    callCtx: ProviderCallContext,
  ): Promise<ReturnType<typeof parseContradictionInput>> {
    const prompt = assembleContradictionPrompt();
    const response = await this.opts.llmProvider.complete(
      {
        model: this.cfg.contradictionModel,
        system: prompt.system,
        messages: [
          {
            role: 'user',
            content: renderContradictionUserMessage(result.answer, result.citations, sources),
          },
        ],
        cacheableSystemPrefix: true,
        tools: [prompt.tool],
        toolChoice: { type: 'tool', name: prompt.toolName },
        maxOutputTokens: CONTRADICTION_MAX_OUTPUT_TOKENS,
      },
      callCtx,
    );
    const call = response.toolCalls.find((c) => c.name === CONTRADICTION_TOOL_NAME);
    return call ? parseContradictionInput(call.input) : [];
  }

  // Parse the forced tool call, then resolve every citation against the
  // visible grounding set. A citation whose sourceId was not part of the
  // prompt is rejected (fails closed — no dead links, no leaked ids). If the
  // model claims an answer but no citation survives, we downgrade to
  // no_evidence rather than surface an ungrounded answer.
  private resolve(
    toolCalls: ReadonlyArray<{ name: string; input: Readonly<Record<string, unknown>> }>,
    sources: readonly GroundedSource[],
    completeness?: AnswerCompleteness,
  ): QueryResult {
    const call = toolCalls.find((c) => c.name === ANSWER_TOOL_NAME);
    if (!call) return this.noEvidence(completeness);

    const parsed = parseAnswerInput(call.input);
    if (!parsed || parsed.status === 'no_evidence') return this.noEvidence(completeness);
    // A blank answer with citations is a nonsense "answered" result; fail
    // closed to no_evidence rather than surface it.
    if (parsed.answer.trim().length === 0) return this.noEvidence(completeness);

    const bySourceId = new Map(sources.map((s) => [s.sourceId, s.paragraph]));
    const citations: Citation[] = [];
    // Dedup by marker: the marker is the [n] the UI renders, so two surviving
    // citations sharing a marker would make [n] ambiguous. Keep the first
    // occurrence of each marker.
    const seenMarkers = new Set<number>();
    for (const c of parsed.citations) {
      const paragraph = bySourceId.get(c.sourceId);
      if (!paragraph) continue; // fabricated / out-of-set citation — drop it.
      // Quote-grounding: the quote must actually come from the cited paragraph.
      // Drop a citation whose quote the model fabricated, even though the source
      // id is real and visible.
      if (!verifyQuoteGrounding(c.quote, paragraph.text)) continue;
      if (seenMarkers.has(c.marker)) continue;
      seenMarkers.add(c.marker);
      citations.push({
        marker: c.marker,
        paragraphId: paragraph.id,
        documentId: paragraph.documentId,
        quote: c.quote,
      });
    }

    // Reconcile markers against the answer text: drop citations whose marker is
    // unused, strip orphan [n] markers left in the text (e.g. by a dropped
    // citation). Keeps the rendered answer and citation list consistent.
    const reconciled = reconcileMarkers(parsed.answer, citations);

    // CLAIM-LEVEL FLOOR (audit #2): a sentence carrying no surviving citation
    // marker asserts something the model did not ground — drop it, so no uncited
    // sentence ever reaches the user. This mirrors the generation path's per-claim
    // policy (generate.ts: "no citation grounded → drop the claim text entirely")
    // and uses the same sentence boundary as the off-path auditor (SENTENCE_END_RE),
    // so Q&A and generation segment answers identically.
    const grounded = dropUncitedSentences(reconciled.answer, reconciled.citations);

    // Floor: an "answered" result with no grounded sentence left is not grounded.
    if (grounded.citations.length === 0) return this.noEvidence(completeness);
    return {
      status: 'answered',
      answer: grounded.answer,
      citations: grounded.citations,
      ...(completeness ? { completeness } : {}),
    };
  }

  private noEvidence(completeness?: AnswerCompleteness): QueryResult {
    return {
      status: 'no_evidence',
      answer: NO_EVIDENCE_MESSAGE,
      citations: [],
      ...(completeness ? { completeness } : {}),
    };
  }
}

// Build the answer completeness disposition from a gather result. The banner is
// SPECIFIC (names the subject + record count) so it cannot be tuned out as
// banner-blindness.
//
// An entity-centric answer can be incomplete for TWO INDEPENDENT reasons, and both
// can hold at once — we surface their UNION honestly:
//   (1) UNLINKED records — the gather may have missed records that could not be
//       linked to the subject (`mayHaveUnlinkedRecords`); and
//   (2) TRUNCATED grounding — fewer of the subject's gathered records reached the
//       grounding prompt than were gathered (`admitted < recordCount`). The banner
//       previously claimed complete whenever (1) was false, even when the model
//       only ever saw the first `maxParagraphs` of N records: the confirmed defect.
//
// UNIT DISCIPLINE: `admitted` is the count of gathered records that ACTUALLY made
// the grounding window (count cap + token ceiling), i.e. `grounding.sources.length`
// on the gather path — the SAME unit as `recordCount` (one gathered record == one
// source paragraph on the gather path). So the comparison is like-for-like; we
// never compare a record count against the paragraph cap.
function buildCompleteness(
  subject: string,
  c: {
    readonly mayHaveUnlinkedRecords: boolean;
    readonly recordCount: number;
    readonly admitted: number;
  },
): AnswerCompleteness {
  const truncated = c.admitted < c.recordCount;
  if (!c.mayHaveUnlinkedRecords && !truncated) {
    return { subject, recordCount: c.recordCount, complete: true, note: null };
  }
  const reasons: string[] = [];
  if (truncated) {
    reasons.push(
      `it is answered from ${c.admitted} of the ${recordWord(c.recordCount)} we could link to them (the rest did not fit the answer's source window)`,
    );
  }
  if (c.mayHaveUnlinkedRecords) {
    reasons.push('there may be further records that could not be linked to them');
  }
  return {
    subject,
    recordCount: c.recordCount,
    complete: false,
    note: `This answer about ${subject} may be incomplete: ${reasons.join('; and ')}.`,
  };
}

function recordWord(n: number): string {
  return `${n} record${n === 1 ? '' : 's'}`;
}

// A surviving citation marker token, e.g. [1] or [12]. Same single-integer form as
// marker-reconcile's MARKER_RE (multi-marker forms like [1, 2] are intentionally
// not recognised — the prompt asks for single-integer markers).
const ANSWER_MARKER_RE = /\[\d+\]/;

// Split an answer into sentences at SENTENCE_END_RE boundaries, KEEPING each
// terminator + trailing whitespace with its sentence and including any trailing
// fragment that has no terminator. The whole input is covered with no gaps, so a
// re-join reproduces the original exactly. Mirrors the boundary the off-path
// auditor uses (query-auditor.ts) so segmentation is consistent across the engine.
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    out.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Claim-level floor for the Q&A path: drop any sentence that carries no surviving
// citation marker, so an ungrounded assertion never reaches the user. Mirrors the
// generation path's per-claim drop (generate.ts). A fully-cited answer (every
// sentence marked) is returned VERBATIM — we never rewrite or re-space a
// legitimate answer. When some sentences are dropped, the kept text is tidied and
// citations are re-scoped to the markers that remain.
function dropUncitedSentences(
  answer: string,
  citations: readonly Citation[],
): { answer: string; citations: readonly Citation[] } {
  const sentences = splitSentences(answer);
  const kept = sentences.filter((s) => ANSWER_MARKER_RE.test(s));
  // Nothing uncited → return verbatim (no over-trim of a fully-grounded answer).
  if (kept.length === sentences.length) return { answer, citations };

  const text = kept
    .join('')
    .replace(/[ \t]{2,}/g, ' ') // collapse doubled spaces left by a removed sentence
    .replace(/[ \t]+\n/g, '\n') // tidy trailing space before a newline
    .trim();
  // Re-scope citations to the markers still present in the kept text. (Dropping a
  // marker-less sentence cannot remove a surviving marker, so this only ever keeps
  // them all; it makes the answer↔citations consistency self-evident.)
  const remaining = new Set<number>();
  for (const m of text.matchAll(/\[(\d+)\]/g)) remaining.add(Number(m[1]));
  return { answer: text, citations: citations.filter((c) => remaining.has(c.marker)) };
}

interface ParsedAnswer {
  readonly status: 'answered' | 'no_evidence';
  readonly answer: string;
  readonly citations: ReadonlyArray<{ marker: number; sourceId: string; quote: string }>;
}

// Lightweight, defensive parse of the tool input. Anthropic constrains the
// shape at decode time via the tool schema; this re-validates as
// defence-in-depth (same discipline as extract/validation.ts) and narrows the
// type. Returns null on a malformed shape, which the caller maps to
// no_evidence.
function parseAnswerInput(input: Readonly<Record<string, unknown>>): ParsedAnswer | null {
  const status = input.status;
  if (status !== 'answered' && status !== 'no_evidence') return null;
  if (typeof input.answer !== 'string') return null;
  if (!Array.isArray(input.citations)) return null;

  const citations: { marker: number; sourceId: string; quote: string }[] = [];
  for (const raw of input.citations) {
    if (raw === null || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.marker !== 'number' || !Number.isInteger(c.marker)) continue;
    if (typeof c.sourceId !== 'string') continue;
    if (typeof c.quote !== 'string') continue;
    citations.push({ marker: c.marker, sourceId: c.sourceId, quote: c.quote });
  }

  return { status, answer: input.answer, citations };
}

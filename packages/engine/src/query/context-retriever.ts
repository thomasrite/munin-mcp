// ContextRetriever — the engine's single, reusable, permission-correct CONTEXT
// SEAM. "Own the layer": given a question (and, optionally, the configuration's
// identity layer), it answers one thing on behalf of any downstream LLM/human —
//
//   "What is the relevant, permission-filtered, ranked context for this caller
//    asking this question?"
//
// It returns ranked GroundedSource paragraphs with their retrieval method and
// relevance + completeness metadata. It performs NO answer synthesis and makes
// NO LLM call beyond the question embedding — grounding + the answer model live
// one layer up (QueryPipeline). Every caller (QueryPipeline, the web ask/
// generate actions, any future API or agent) routes through this one surface
// instead of re-deriving classify → resolve → gather.
//
// TWO retrieval paths, selected by classifyQuestion (G1 / F31), which routes on
// ENTITY-PRESENCE not phrasing:
//   • OPEN question → HYBRID retrieval: vector (semantic) search + keyword
//     (lexical / full-text) search, FUSED by weighted reciprocal-rank fusion
//     (default ≈60/40 semantic/keyword, configurable per vertical), then an
//     optional RECENCY decay tilts the ranking toward current documents (the
//     freshness problem — superseded policies, old term dates) → depth-1 graph
//     expansion → budget/select. The keyword path catches exact terms, proper
//     nouns, codes, and spelling variants that semantic similarity ranks poorly.
//     Recency is a SOFT, never-zeroing signal (old material stays reachable) and
//     opt-in per vertical. No per-subject completeness is implied, so this path
//     never asserts completeness. (keywordWeight = 0 + recency off ⇒ legacy
//     vector-only behaviour.)
//   • ENTITY-CENTRIC question (names a visible subject) → resolve → (disambiguate
//     same-name) → gatherByIdentity → materialise → budget/select, attaching a
//     SPECIFIC completeness disposition computed from the gather.
//
// PERMISSION-CORRECT BY CONSTRUCTION: every read runs under the caller's
// ReadContext exactly as passed in — there is NO internalBypass anywhere on this
// path, and no accessTags default. A stale/over-broad embedding row cannot leak
// content because materialisation re-applies the access filter; an
// out-of-clearance same-name subject is never resolved, offered, or counted.
//
// VERTICAL-AGNOSTIC: the subject entity types + the identity hooks
// (EntityResolutionHints) come from configuration; the engine names no vertical
// concept.

import type { EntityResolutionHints } from '@muninhq/shared';
import type { GraphStore } from '../graph/graph-store';
import type {
  Document,
  DocumentId,
  Entity,
  Paragraph,
  ParagraphId,
  ReadContext,
  TenantId,
} from '../graph/types';
import type { EmbeddingProvider, ProviderCallContext, RerankProvider } from '../providers';
import { type QuestionClassification, classifyQuestion } from './classify-question';
import type { DisambiguationGroup } from './disambiguation';
import { type GatherTarget, gatherByIdentity } from './gather';
import { type GroundingCandidate, buildGroundingContext } from './grounding';
import type { ResolvableEntity } from './resolution';
import { loadResolvableSubjects, resolveSubjectToGatherTarget } from './resolve-target';

// How a source reached the grounding set:
//   • 'vector'  — surfaced by the semantic (vector) path, possibly also lexically
//                 (direct hit when `distance` is set; graph-expansion when null);
//   • 'keyword' — surfaced by the lexical (full-text) path and NOT by the
//                 within-threshold vector set — the exact-term / proper-noun lift;
//   • 'gather'  — assembled by identity gather (entity-centric path).
export type RetrievalMethod = 'vector' | 'keyword' | 'gather';

// One ranked, permission-filtered source paragraph, ready to hand to an LLM. A
// structural superset of grounding's GroundedSource and generate's
// GenerationSource (both consume `{ sourceId, paragraph, documentTitle? }`), so
// it is directly usable by the grounding/answer and template-generation paths.
export interface ContextSource {
  // Stable label used in the prompt and in the model's citations, e.g. "P1".
  readonly sourceId: string;
  readonly paragraph: Paragraph;
  // How this source was retrieved (see RetrievalMethod).
  readonly method: RetrievalMethod;
  // Cosine distance from the query vector (0 = identical) for a direct vector
  // hit; null for sources included structurally (graph expansion / gather).
  readonly distance: number | null;
  readonly documentTitle?: string;
}

// The gather's completeness, visible-scoped. `mayHaveUnlinkedRecords` true → the
// downstream answer/document should carry the SPECIFIC "may be incomplete"
// banner. Never reflects permission-withheld records (that would leak them).
export interface ContextCompleteness {
  readonly subject: string;
  readonly recordCount: number;
  readonly mayHaveUnlinkedRecords: boolean;
}

// The optional identity layer. Supplied by callers that hold a configuration
// (the web); when omitted, retrieval is always the OPEN vector path (the engine
// names no subject type, so it cannot route by identity on its own).
export interface IdentityRouting {
  // The configured subject entity types (e.g. document-template subjects).
  readonly subjectTypes: readonly string[];
  // Per-type identity hooks (config `EntityResolutionHints`).
  readonly hintsByType: ReadonlyMap<string, EntityResolutionHints>;
  // A disambiguation selection token from a prior turn (the "pick"). Absent on
  // the first turn.
  readonly pick?: string;
  // Cap on the visible subject-entity page. If the caller can see more than this
  // many subjects, retrieval falls back to the OPEN path rather than resolve on
  // a truncated set (honesty over a silent partial gather). Default 5000.
  readonly entityPageLimit?: number;
}

// Per-request override of the retrieval knobs (otherwise the retriever defaults).
export interface ContextRetrievalOverrides {
  readonly k?: number;
  readonly maxParagraphs?: number;
  readonly distanceThreshold?: number;
  readonly tokenCeiling?: number;
  // Hybrid blend weight on the keyword/lexical path: 0 = vector-only (legacy),
  // 1 = keyword-only. Default 0.4 (≈60/40 semantic/keyword).
  readonly keywordWeight?: number;
  // Keyword search breadth. Defaults to the vector `k`.
  readonly keywordK?: number;
  // Recency decay half-life in days for the open ranking path. Older paragraphs
  // decay toward (but never below) a floor, so current docs outrank stale ones
  // without losing old material. Undefined / ≤ 0 ⇒ recency OFF.
  readonly recencyHalfLifeDays?: number;
  // Multiplier on the score of paragraphs in a superseded document version. 1
  // disables the demote; < 1 demotes (never drops). Default 0.5.
  readonly supersededDemotionFactor?: number;
}

export interface ContextRequest {
  readonly question: string;
  readonly identity?: IdentityRouting;
  readonly options?: ContextRetrievalOverrides;
}

// The retrieval outcome. Either the ranked context (open or gather), or a
// same-name collision that the caller must resolve with a pick before gather.
export type GroundedContext =
  | {
      readonly kind: 'context';
      readonly method: RetrievalMethod;
      // What classifyQuestion decided (open / entity-centric) — transparency for
      // the caller; 'open' on the pure vector path with no identity layer.
      readonly classification: QuestionClassification;
      // Ranked, permission-filtered, budget-selected sources in prompt order.
      readonly sources: readonly ContextSource[];
      // The rendered grounding prompt carrying the numbered sources, or null when
      // no source survived selection (the caller short-circuits to no_evidence).
      readonly message: string | null;
      // The named subject (entity-centric gather path) else null.
      readonly subject: string | null;
      // Present (and possibly a banner) ONLY on the gather path; null on the open
      // path — the engine never asserts completeness it did not earn.
      readonly completeness: ContextCompleteness | null;
    }
  | {
      readonly kind: 'disambiguation';
      readonly classification: QuestionClassification;
      // The named identity the candidates collide on (display).
      readonly subject: string;
      // The M1.3 candidate package (engine-tier; the caller enriches for display).
      readonly group: DisambiguationGroup;
      // The already-visible resolvable entities, so the caller can project extra
      // distinguishing display info without an additional read.
      readonly entitiesById: ReadonlyMap<string, ResolvableEntity>;
      // True when a prior pick token no longer matched any candidate (the visible
      // set changed) — the caller re-presents with a "no longer available" note.
      readonly pickWasStale: boolean;
    };

// Materialised gather output: all of a target's records as ranked sources, plus
// the gather's completeness. NOT budget-trimmed — callers that synthesise per
// section (template generation) want the complete set and chunk it themselves.
export interface GatheredContextSources {
  readonly sources: readonly ContextSource[];
  readonly mayHaveUnlinkedRecords: boolean;
  readonly recordCount: number;
}

export interface ContextRetrieverOptions {
  readonly graphStore: GraphStore;
  readonly embeddingProvider: EmbeddingProvider;
  // Vector search breadth (top-k). Default 20.
  readonly k?: number;
  // Max paragraphs admitted to the grounding selection. Default 12.
  readonly maxParagraphs?: number;
  // Cosine-distance cutoff for vector hits. Default 0.6.
  readonly distanceThreshold?: number;
  // Token ceiling for the grounding sources. Default 6000.
  readonly tokenCeiling?: number;
  // Per-entity neighbour cap during open-path graph expansion. Default 25.
  readonly expansionBreadth?: number;
  // Hybrid blend weight on the keyword/lexical path (open path): 0 = vector-only
  // (legacy behaviour), 1 = keyword-only. Default 0.4 (≈60/40 semantic/keyword).
  // Per-vertical via Configuration.queryDefaults.
  readonly keywordWeight?: number;
  // Keyword search breadth. Defaults to the vector `k`.
  readonly keywordK?: number;
  // Recency decay half-life in days for the open ranking path. Older paragraphs
  // decay toward a floor so current docs outrank stale ones (the freshness
  // problem). Undefined / ≤ 0 ⇒ recency OFF (default). Per-vertical via
  // Configuration.queryDefaults — fast for HR/policies, slow/off for legislation.
  readonly recencyHalfLifeDays?: number;
  // Multiplier on the open-path score of paragraphs in a SUPERSEDED document
  // version (validTo set), so the current version outranks its predecessors. In
  // [0,1]; 1 disables the demote (default 0.5). Superseded paragraphs are demoted,
  // NEVER dropped — they stay in the result set.
  readonly supersededDemotionFactor?: number;
  // Optional reranker. When present, the open path retrieves a WIDE pool (vector +
  // keyword), then this re-scores the top `rerankCandidates` by precise query-
  // document relevance and promotes them — pulling the right document above a noisy
  // hybrid cutoff (the scale ranking fix). It re-orders ONLY the already-retrieved,
  // already-permission-filtered candidates; it cannot surface anything new.
  readonly rerankProvider?: RerankProvider;
  // How many of the wide pool to hand the reranker (prompt/cost bound). Default 60.
  readonly rerankCandidates?: number;
}

interface ResolvedOptions {
  readonly k: number;
  readonly maxParagraphs: number;
  readonly distanceThreshold: number;
  readonly tokenCeiling: number;
  readonly expansionBreadth: number;
  readonly keywordWeight: number;
  readonly keywordK: number;
  // 0 ⇒ recency off (engine default — recency is opt-in per vertical).
  readonly recencyHalfLifeDays: number;
  // Clamped to [0,1]. 1 ⇒ demotion off; < 1 ⇒ superseded versions demoted.
  readonly supersededDemotionFactor: number;
}

// Reciprocal-rank-fusion constant. The standard RRF dampening term: a hit's
// contribution is 1/(RRF_K + rank). 60 is the widely-used default — large enough
// that the top few ranks are close, so neither path dominates on rank-1 alone.
const RRF_K = 60;

export class ContextRetriever {
  private readonly store: GraphStore;
  private readonly embedding: EmbeddingProvider;
  private readonly cfg: ResolvedOptions;
  private readonly rerankProvider: RerankProvider | undefined;
  private readonly rerankCandidates: number;

  constructor(opts: ContextRetrieverOptions) {
    this.store = opts.graphStore;
    this.embedding = opts.embeddingProvider;
    this.rerankProvider = opts.rerankProvider;
    this.rerankCandidates = opts.rerankCandidates ?? 60;
    const k = opts.k ?? 20;
    this.cfg = {
      k,
      maxParagraphs: opts.maxParagraphs ?? 12,
      distanceThreshold: opts.distanceThreshold ?? 0.6,
      tokenCeiling: opts.tokenCeiling ?? 6000,
      expansionBreadth: opts.expansionBreadth ?? 25,
      // Hybrid ON by default (≈60/40 semantic/keyword). Clamp to [0,1].
      keywordWeight: clamp01(opts.keywordWeight ?? 0.4),
      keywordK: opts.keywordK ?? k,
      // Recency OFF by default — opt-in per vertical (decay is vertical-specific:
      // harmful for legislation/precedent, useful for HR/policies). 0 ⇒ off.
      recencyHalfLifeDays: Math.max(0, opts.recencyHalfLifeDays ?? 0),
      // Superseded-version demotion ON by default (0.5): a generic freshness
      // signal independent of any vertical. Clamp to [0,1]; 1 disables it.
      supersededDemotionFactor: clamp01(opts.supersededDemotionFactor ?? 0.5),
    };
  }

  /**
   * Retrieve the ranked, permission-filtered context for a question. Routes to
   * the open vector path or the entity-centric gather path (when an identity
   * layer is supplied and the question names a visible subject), or signals a
   * same-name disambiguation. Reads only under `ctx` (no bypass).
   */
  async retrieveContext(ctx: ReadContext, request: ContextRequest): Promise<GroundedContext> {
    const identity = request.identity;
    // No identity layer → always the open vector path. The engine cannot route
    // by identity without the configuration's subject types.
    if (!identity || identity.subjectTypes.length === 0) {
      return this.openVector(ctx, request.question, { kind: 'open' }, request.options);
    }

    // Caller-visible entities of the subject types (permission-scoped read).
    // Honesty over a silent guess: a truncated candidate set could miss the
    // subject or partial-gather a cluster, so fall back to the OPEN path (which
    // claims no completeness) rather than resolve on an incomplete set.
    const loaded = await loadResolvableSubjects(
      this.store,
      ctx,
      identity.subjectTypes,
      identity.entityPageLimit,
    );
    if (loaded.kind === 'truncated') {
      return this.openVector(ctx, request.question, { kind: 'open' }, request.options);
    }

    const classification = classifyQuestion({
      question: request.question,
      entities: loaded.resolvable,
      hintsByType: identity.hintsByType,
    });
    if (classification.kind !== 'entity-centric') {
      return this.openVector(ctx, request.question, classification, request.options);
    }
    return this.entityCentric(
      ctx,
      request.question,
      loaded.resolvable,
      identity,
      classification,
      request.options,
    );
  }

  /**
   * Gather all of a resolved target's records (permission-correct, key-led) and
   * materialise them into ranked sources, with the gather's completeness. The
   * complete set (not budget-trimmed) — used by the entity path internally and
   * by callers that resolved a target themselves (e.g. template generation).
   */
  async gatherSources(ctx: ReadContext, target: GatherTarget): Promise<GatheredContextSources> {
    // gatherByIdentity uses its own default neighbour cap (matching the existing
    // web gather), independent of the open-path expansion breadth.
    const gathered = await gatherByIdentity(this.store, ctx, target);

    // Materialise the gathered records' source paragraphs. Every read re-applies
    // the access filter, so the result can include only what the caller may see.
    const entities = await this.store.getEntitiesByIds(ctx, gathered.entityIds);
    const paraIds = entities
      .map((e) => (e.provenance.kind === 'document_extract' ? e.provenance.paragraphId : null))
      .filter((p): p is ParagraphId => p !== null);
    const paras = await this.store.getParagraphsByIds(ctx, paraIds);
    const titleByDoc = await this.collectDocumentTitles(ctx, paras);
    const sources: ContextSource[] = paras.map((p, i) => {
      const title = titleByDoc.get(p.documentId);
      return {
        sourceId: `P${i + 1}`,
        paragraph: p,
        method: 'gather' as const,
        distance: null,
        ...(title !== undefined ? { documentTitle: title } : {}),
      };
    });
    return {
      sources,
      mayHaveUnlinkedRecords: gathered.mayHaveUnlinkedRecords,
      recordCount: sources.length,
    };
  }

  // --- internals ----------------------------------------------------------

  // The open retrieval path: embed → tenant + tag-filtered VECTOR search, plus a
  // parallel KEYWORD (lexical) search, FUSED by weighted reciprocal-rank fusion,
  // then optionally RE-WEIGHTED by a recency decay → materialise → depth-1 graph
  // expansion → budget/select. The vector-only steps mirror the prior
  // QueryPipeline.computeAnswer 1–5; the keyword path is the hybrid addition for
  // exact terms / proper nouns / spelling variants that semantic similarity ranks
  // poorly; recency tilts toward current documents (the freshness problem). When
  // keywordWeight === 0 (or keyword adds nothing) AND recency is off, the path is
  // byte-identical to the legacy vector-only pipeline.
  private async openVector(
    ctx: ReadContext,
    question: string,
    classification: QuestionClassification,
    overrides: ContextRetrievalOverrides | undefined,
  ): Promise<GroundedContext> {
    const callCtx: ProviderCallContext = {
      tenantId: ctx.tenantId,
      purpose: 'query',
      graphStore: this.store,
    };
    const k = overrides?.k ?? this.cfg.k;
    const distanceThreshold = overrides?.distanceThreshold ?? this.cfg.distanceThreshold;
    const keywordWeight = clamp01(overrides?.keywordWeight ?? this.cfg.keywordWeight);
    const keywordK = overrides?.keywordK ?? this.cfg.keywordK;

    const embedded = await this.embedding.embed({ texts: [question], kind: 'query' }, callCtx);
    const queryVector = embedded.vectors[0];
    if (!queryVector) return this.emptyContext('vector', classification);

    const vectorHits = (
      await this.store.searchByVector(ctx, { modelId: this.embedding.modelId, k, queryVector })
    ).filter((h) => h.targetKind === 'paragraph');

    // Min distance per paragraph (defensive; buildGroundingContext dedups again).
    const distanceByParagraph = new Map<ParagraphId, number>();
    const vectorOrder: ParagraphId[] = [];
    for (const h of vectorHits) {
      // reason: VectorSearchResult.targetId is typed `string`; the preceding
      // targetKind === 'paragraph' filter guarantees it is a ParagraphId.
      const id = h.targetId as ParagraphId;
      if (!distanceByParagraph.has(id)) vectorOrder.push(id);
      const prev = distanceByParagraph.get(id);
      if (prev === undefined || h.distance < prev) distanceByParagraph.set(id, h.distance);
    }

    // Keyword (lexical) search — skipped entirely when keywordWeight === 0, so the
    // vector-only path stays byte-identical to the pre-hybrid pipeline.
    const keywordHits =
      keywordWeight > 0
        ? await this.store.searchByKeyword(ctx, { query: question, k: keywordK })
        : [];
    const hybrid = keywordWeight > 0 && keywordHits.length > 0;
    const recencyHalfLifeDays = overrides?.recencyHalfLifeDays ?? this.cfg.recencyHalfLifeDays;
    const recencyOn = recencyHalfLifeDays > 0;
    const supersededDemotionFactor =
      overrides?.supersededDemotionFactor ?? this.cfg.supersededDemotionFactor;
    const demoteOn = supersededDemotionFactor < 1;
    // The RRF-scored path is used whenever the keyword path contributes, recency
    // is on, OR superseded-version demotion is on (all re-weight the RRF score).
    // Pure vector-only with all three off keeps the legacy distance-ordered path.
    const scored = hybrid || recencyOn || demoteOn;

    let retrievedIds: ParagraphId[];
    let fusedRankById: ReadonlyMap<ParagraphId, number> | null = null;
    let methodById: ReadonlyMap<ParagraphId, RetrievalMethod> | null = null;
    let scoreById: ReadonlyMap<ParagraphId, number> | null = null;
    let rrfRankById: ReadonlyMap<ParagraphId, number> | null = null;
    if (scored) {
      // Fuse over within-threshold vector hits (the threshold gates the vector
      // contribution here, since fused candidates are threshold-exempt downstream)
      // and the keyword hits (only in hybrid mode — keyword relevance is its own gate).
      const fused = fuseVectorKeyword({
        vector: vectorOrder.filter(
          (id) => (distanceByParagraph.get(id) ?? Number.POSITIVE_INFINITY) <= distanceThreshold,
        ),
        keyword: hybrid ? keywordHits.map((h) => h.targetId as ParagraphId) : [],
        keywordWeight: hybrid ? keywordWeight : 0,
        limit: Math.max(k, keywordK),
      });
      retrievedIds = fused.order;
      scoreById = fused.scoreById;
      rrfRankById = fused.rankById;
      // Per-source 'keyword' marking only when the keyword path actually ran.
      methodById = hybrid ? fused.methodById : null;
    } else {
      // Legacy vector-only: materialise all vector hits; buildGroundingContext
      // applies the distance threshold + distance-asc ordering, exactly as before.
      retrievedIds = vectorOrder;
    }

    const retrieved = await this.materialiseParagraphs(ctx, retrievedIds);

    // Documents for the retrieved paragraphs — needed for two ranking signals:
    //   • F40 recency decays by the document's real-world date (sourceModifiedAt),
    //     falling back to the paragraph's ingestion time when absent.
    //   • supersession demotion lowers paragraphs in a superseded version (validTo
    //     set) so the current version outranks them — they are demoted, NEVER
    //     dropped. One batched, permission-filtered read, only when a doc-derived
    //     signal is active (else the legacy path skips it).
    const retrievedDocs =
      scored && scoreById && (recencyOn || demoteOn)
        ? await this.collectDocuments(ctx, retrieved)
        : null;

    // Re-rank: re-weight the fused RRF score by recency (sourceModifiedAt) and the
    // superseded-version demotion, then re-derive the fused order. Open path only;
    // the gather path is completeness-first (untouched). Both signals are SOFT —
    // they reorder, never remove (superseded paragraphs stay in the result set).
    if (scored && scoreById) {
      if (retrievedDocs) {
        const nowMs = Date.now();
        const finalScore = (p: Paragraph): number => {
          const base = scoreById?.get(p.id) ?? 0;
          const doc = retrievedDocs.get(p.documentId);
          const recency = recencyOn
            ? recencyMultiplier(
                ageInDays(doc?.sourceModifiedAt ?? p.createdAt, nowMs),
                recencyHalfLifeDays,
              )
            : 1;
          const demote = demoteOn && doc?.validTo != null ? supersededDemotionFactor : 1;
          return base * recency * demote;
        };
        const ranked = [...retrieved].sort((a, b) => {
          const d = finalScore(b) - finalScore(a);
          return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
        });
        fusedRankById = new Map(ranked.map((p, i) => [p.id, i]));
      } else {
        fusedRankById = rrfRankById;
      }
    }

    const maxParagraphs = overrides?.maxParagraphs ?? this.cfg.maxParagraphs;

    // RERANK (open path): re-score the top of the WIDE pool by precise query-
    // document relevance and promote the winners, pulling the right document above
    // a noisy hybrid cutoff (the scale ranking fix). Operates ONLY on `retrieved` —
    // already materialised and permission-filtered — so it can never surface a
    // document outside the caller's clearance. Best-effort: a reranker hiccup falls
    // back to the existing fused order, never failing the query.
    if (this.rerankProvider && retrieved.length > 1) {
      try {
        const ordered = [...retrieved].sort((a, b) => {
          const ra =
            fusedRankById?.get(a.id) ?? distanceByParagraph.get(a.id) ?? Number.POSITIVE_INFINITY;
          const rb =
            fusedRankById?.get(b.id) ?? distanceByParagraph.get(b.id) ?? Number.POSITIVE_INFINITY;
          return ra - rb;
        });
        const pool = ordered.slice(
          0,
          Math.min(this.rerankCandidates, this.rerankProvider.maxDocuments),
        );
        const { ranking } = await this.rerankProvider.rerank(
          {
            query: question,
            documents: pool.map((p) => ({ id: String(p.id), text: p.text })),
            topK: maxParagraphs,
          },
          callCtx,
        );
        if (ranking.length > 0) {
          const rerankRank = new Map<ParagraphId, number>();
          ranking.forEach((r, i) => rerankRank.set(r.id as ParagraphId, i));
          // Winners first (0..K-1); everything else keeps its relative order, pushed
          // below the reranked set so grounding admits the reranked top first.
          const offset = ranking.length;
          const next = new Map<ParagraphId, number>();
          for (const p of retrieved) {
            const r = rerankRank.get(p.id);
            next.set(p.id, r !== undefined ? r : offset + (fusedRankById?.get(p.id) ?? 0));
          }
          fusedRankById = next;
        }
      } catch (err) {
        // Reranking is a relevance refinement, not a correctness gate — a provider
        // hiccup must not fail the query; fall back to the fused order.
        console.warn(
          `[context-retriever] rerank failed, using fused order: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const expanded = await this.expand(ctx, retrieved);

    const titleByDoc = await this.collectDocumentTitles(ctx, [...retrieved, ...expanded]);
    const candidates: GroundingCandidate[] = [
      ...retrieved.map((p) =>
        this.toCandidate(
          p,
          distanceByParagraph.get(p.id) ?? null,
          titleByDoc,
          fusedRankById?.get(p.id),
        ),
      ),
      ...expanded.map((p) => this.toCandidate(p, null, titleByDoc)),
    ];

    const grounding = buildGroundingContext(question, candidates, {
      distanceThreshold,
      maxParagraphs,
      tokenCeiling: overrides?.tokenCeiling ?? this.cfg.tokenCeiling,
    });
    return {
      kind: 'context',
      method: 'vector',
      classification,
      sources: this.toContextSources(
        grounding.sources,
        'vector',
        distanceByParagraph,
        titleByDoc,
        methodById,
      ),
      message: grounding.message,
      subject: null,
      completeness: null,
    };
  }

  // The entity-centric path: resolve → (disambiguate same-name) → gather → budget.
  // The resolve decision is the SHARED, single-sourced seam
  // (resolveSubjectToGatherTarget) the web generate action also routes through;
  // this method maps the outcome to the Q&A surface.
  private async entityCentric(
    ctx: ReadContext,
    question: string,
    resolvable: readonly ResolvableEntity[],
    identity: IdentityRouting,
    classification: Extract<QuestionClassification, { kind: 'entity-centric' }>,
    overrides?: ContextRetrievalOverrides,
  ): Promise<GroundedContext> {
    const resolved = resolveSubjectToGatherTarget({
      resolvable,
      subjectKey: classification.subjectKey,
      entityType: classification.entityType,
      hintsByType: identity.hintsByType,
      ...(identity.pick ? { pick: identity.pick } : {}),
    });

    if (resolved.kind === 'disambiguation') {
      return this.disambiguation(
        classification,
        resolved.group,
        resolved.entitiesById,
        resolved.pickWasStale,
      );
    }
    if (resolved.kind === 'target') {
      return this.gatherContext(
        ctx,
        question,
        resolved.target,
        resolved.subject,
        classification,
        overrides,
      );
    }
    // 'ambiguous' (a loose name matched several DISTINCT people) or 'not-found':
    // fall back to the OPEN vector path, which makes NO per-person completeness
    // claim — safer than gathering one arbitrarily-chosen subject. (Document
    // generation instead asks the user to be more specific; it must target one.)
    return this.openVector(ctx, question, classification, overrides);
  }

  // Gather + materialise a target's records, then budget/select over the question
  // (same selection bounds as the open path) and attach the gather completeness.
  private async gatherContext(
    ctx: ReadContext,
    question: string,
    target: GatherTarget,
    subjectDisplay: string,
    classification: QuestionClassification,
    overrides: ContextRetrievalOverrides | undefined,
  ): Promise<GroundedContext> {
    const gathered = await this.gatherSources(ctx, target);
    const maxParagraphs = overrides?.maxParagraphs ?? this.cfg.maxParagraphs;

    // HYBRID gather ∪ open. Gather-by-identity assembles ALL of one entity's
    // records by IDENTITY, not by relevance to THIS question — great for "everything
    // about X", but for a specific-fact question ("the outcome of X's grievance") the
    // one answer-bearing record may not be reachable through the (noisy, sparsely-
    // keyed) identity at scale, while content retrieval finds it directly. So we
    // UNION the gathered records with the question's open retrieval and let the
    // reranker pick: it is instructed to prefer the named subject AND relevance, so
    // the subject's answer document surfaces while completeness is still present.
    // Permission-correct: both halves read under the caller's ReadContext (gather +
    // open are each access-tag filtered); the reranker only re-orders that set.
    const open = await this.retrieveRelevantParagraphs(ctx, question, overrides);
    const ordered: Paragraph[] = [];
    const seen = new Set<string>();
    for (const s of gathered.sources) {
      const id = String(s.paragraph.id);
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(s.paragraph);
      }
    }
    for (const p of open.paragraphs) {
      const id = String(p.id);
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(p);
      }
    }
    const titleByDoc = await this.collectDocumentTitles(ctx, ordered);

    // Re-score the union by the question and surface the winners (best-effort).
    const rerankRank = await this.rerankGathered(
      question,
      ordered.map((p) => ({ paragraph: p })),
      ctx.tenantId,
      maxParagraphs,
    );
    // Base order without a reranker: question-relevant open hits first (by their
    // retrieval rank), then the remaining gather-only records (completeness).
    const baseRank = (id: string, idx: number): number =>
      open.rankById.get(id) ?? open.rankById.size + idx;
    const candidates: GroundingCandidate[] = ordered.map((p, idx) => {
      const id = String(p.id);
      const title = titleByDoc.get(p.documentId);
      // Reranked winners take ranks 0..K-1; everything else is pushed below, kept in
      // relevance-then-completeness order. All candidates carry a fusedRank, so they
      // are threshold-exempt (they earned inclusion by identity or relevance) and the
      // count cap admits the most relevant first.
      const fusedRank = rerankRank
        ? (rerankRank.get(id) ?? rerankRank.size + baseRank(id, idx))
        : baseRank(id, idx);
      return {
        paragraph: p,
        distance: null,
        ...(title !== undefined ? { documentTitle: title } : {}),
        fusedRank,
      };
    });
    const grounding = buildGroundingContext(question, candidates, {
      distanceThreshold: overrides?.distanceThreshold ?? this.cfg.distanceThreshold,
      maxParagraphs,
      tokenCeiling: overrides?.tokenCeiling ?? this.cfg.tokenCeiling,
    });
    return {
      kind: 'context',
      method: 'gather',
      classification,
      sources: this.toContextSources(grounding.sources, 'gather', new Map(), titleByDoc),
      message: grounding.message,
      subject: subjectDisplay,
      completeness: {
        subject: subjectDisplay,
        recordCount: gathered.recordCount,
        mayHaveUnlinkedRecords: gathered.mayHaveUnlinkedRecords,
      },
    };
  }

  // Question-relevant paragraphs via the open vector+keyword path, materialised and
  // permission-filtered (reads under `ctx`). Used to seed the gather path with the
  // records that answer THIS question (which identity-gather may not reach at
  // scale). Returns the paragraphs and a relevance rank (0 = best). No recency, no
  // graph expansion — purely the relevance retrieval the gather union needs.
  private async retrieveRelevantParagraphs(
    ctx: ReadContext,
    question: string,
    overrides: ContextRetrievalOverrides | undefined,
  ): Promise<{ paragraphs: Paragraph[]; rankById: ReadonlyMap<string, number> }> {
    const callCtx: ProviderCallContext = {
      tenantId: ctx.tenantId,
      purpose: 'query',
      graphStore: this.store,
    };
    const k = overrides?.k ?? this.cfg.k;
    const distanceThreshold = overrides?.distanceThreshold ?? this.cfg.distanceThreshold;
    const keywordWeight = clamp01(overrides?.keywordWeight ?? this.cfg.keywordWeight);
    const keywordK = overrides?.keywordK ?? this.cfg.keywordK;

    const embedded = await this.embedding.embed({ texts: [question], kind: 'query' }, callCtx);
    const queryVector = embedded.vectors[0];
    if (!queryVector) return { paragraphs: [], rankById: new Map() };

    const vectorHits = (
      await this.store.searchByVector(ctx, { modelId: this.embedding.modelId, k, queryVector })
    ).filter((h) => h.targetKind === 'paragraph');
    const distanceByParagraph = new Map<ParagraphId, number>();
    const vectorOrder: ParagraphId[] = [];
    for (const h of vectorHits) {
      const id = h.targetId as ParagraphId;
      if (!distanceByParagraph.has(id)) vectorOrder.push(id);
      const prev = distanceByParagraph.get(id);
      if (prev === undefined || h.distance < prev) distanceByParagraph.set(id, h.distance);
    }
    const withinThreshold = vectorOrder.filter(
      (id) => (distanceByParagraph.get(id) ?? Number.POSITIVE_INFINITY) <= distanceThreshold,
    );
    const keywordHits =
      keywordWeight > 0
        ? await this.store.searchByKeyword(ctx, { query: question, k: keywordK })
        : [];

    const order =
      keywordWeight > 0 && keywordHits.length > 0
        ? fuseVectorKeyword({
            vector: withinThreshold,
            keyword: keywordHits.map((h) => h.targetId as ParagraphId),
            keywordWeight,
            limit: Math.max(k, keywordK),
          }).order
        : withinThreshold;

    const rankById = new Map<string, number>();
    order.forEach((id, i) => rankById.set(String(id), i));
    const paragraphs = await this.materialiseParagraphs(ctx, order);
    return { paragraphs, rankById };
  }

  // Re-score gathered records by relevance to the question, returning winner ranks
  // (0 = most relevant). Returns null when there is no reranker, too few records to
  // order, or the provider errs — callers then keep the structural gather order.
  // Permission-correct by construction: the records were gathered under the
  // caller's ReadContext; the reranker only re-orders that already-filtered set.
  private async rerankGathered(
    question: string,
    sources: readonly { paragraph: Paragraph }[],
    tenantId: TenantId,
    maxParagraphs: number,
  ): Promise<ReadonlyMap<string, number> | null> {
    if (!this.rerankProvider || sources.length <= 1) return null;
    const callCtx: ProviderCallContext = { tenantId, purpose: 'query', graphStore: this.store };
    try {
      const pool = sources.slice(
        0,
        Math.min(this.rerankCandidates, this.rerankProvider.maxDocuments),
      );
      const { ranking } = await this.rerankProvider.rerank(
        {
          query: question,
          documents: pool.map((s) => ({ id: String(s.paragraph.id), text: s.paragraph.text })),
          topK: maxParagraphs,
        },
        callCtx,
      );
      if (ranking.length === 0) return null;
      const ranks = new Map<string, number>();
      ranking.forEach((r, i) => ranks.set(r.id, i));
      return ranks;
    } catch (err) {
      console.warn(
        `[context-retriever] gather rerank failed, using gather order: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private disambiguation(
    classification: QuestionClassification,
    group: DisambiguationGroup,
    entitiesById: ReadonlyMap<string, ResolvableEntity>,
    pickWasStale: boolean,
  ): GroundedContext {
    const subject =
      classification.kind === 'entity-centric' ? classification.subjectKey : group.identityKey;
    return { kind: 'disambiguation', classification, subject, group, entitiesById, pickWasStale };
  }

  private emptyContext(
    method: RetrievalMethod,
    classification: QuestionClassification,
  ): GroundedContext {
    return {
      kind: 'context',
      method,
      classification,
      sources: [],
      message: null,
      subject: null,
      completeness: null,
    };
  }

  // Map the budget-selected GroundedSources back to ContextSources, attaching the
  // retrieval method, the vector distance (when a direct hit), and the doc title.
  // `methodById` (hybrid) gives the per-source method (vector vs keyword); any
  // source not in it (e.g. graph expansion) falls back to `fallbackMethod`.
  private toContextSources(
    selected: readonly { sourceId: string; paragraph: Paragraph }[],
    fallbackMethod: RetrievalMethod,
    distanceByParagraph: ReadonlyMap<ParagraphId, number>,
    titleByDoc: ReadonlyMap<DocumentId, string>,
    methodById?: ReadonlyMap<ParagraphId, RetrievalMethod> | null,
  ): ContextSource[] {
    return selected.map((s) => {
      const title = titleByDoc.get(s.paragraph.documentId);
      return {
        sourceId: s.sourceId,
        paragraph: s.paragraph,
        method: methodById?.get(s.paragraph.id) ?? fallbackMethod,
        distance: distanceByParagraph.get(s.paragraph.id) ?? null,
        ...(title !== undefined ? { documentTitle: title } : {}),
      };
    });
  }

  private async materialiseParagraphs(
    ctx: ReadContext,
    ids: readonly ParagraphId[],
  ): Promise<Paragraph[]> {
    // Batched read: re-applies the access filter (a stale/over-broad embedding
    // row cannot leak content) and drops anything the caller cannot see.
    return [...(await this.store.getParagraphsByIds(ctx, ids))];
  }

  // Generic depth-1 expansion. From the entities extracted in the retrieved
  // paragraphs, take a single hop to neighbour entities (all edge types,
  // breadth-capped) and gather the paragraphs those neighbours were extracted
  // from. Every read carries the caller's tags, so anything they cannot see is
  // dropped before it can reach the prompt.
  private async expand(ctx: ReadContext, retrieved: readonly Paragraph[]): Promise<Paragraph[]> {
    if (retrieved.length === 0) return [];

    const seedEntities = await this.store.findEntitiesByParagraphIds(
      ctx,
      retrieved.map((p) => p.id),
    );

    const neighbourParagraphIds = new Set<ParagraphId>();
    const seenParagraphIds = new Set<ParagraphId>(retrieved.map((p) => p.id));
    for (const entity of seedEntities) {
      // The breadth cap is best-effort recall, not a deterministic selection:
      // which neighbours return when an entity has more than `expansionBreadth`
      // depends on the GraphStore's ordering. Acceptable for generic depth-1.
      const { entities: neighbours } = await this.store.getNeighbours(ctx, entity.id, {
        direction: 'both',
        limit: this.cfg.expansionBreadth,
      });
      for (const n of neighbours) {
        const pid = paragraphOf(n);
        if (pid && !seenParagraphIds.has(pid)) neighbourParagraphIds.add(pid);
      }
    }

    return this.materialiseParagraphs(ctx, [...neighbourParagraphIds]);
  }

  private async collectDocumentTitles(
    ctx: ReadContext,
    paragraphs: readonly Paragraph[],
  ): Promise<Map<DocumentId, string>> {
    const titles = new Map<DocumentId, string>();
    const uniqueIds = [...new Set(paragraphs.map((p) => p.documentId))];
    const docs = await this.store.getDocumentsByIds(ctx, uniqueIds);
    for (const doc of docs) titles.set(doc.id, doc.title);
    return titles;
  }

  // The documents backing a set of paragraphs, keyed by id. Permission-filtered
  // (getDocumentsByIds drops anything the caller can't see). Used by the open-path
  // re-rank for the recency (sourceModifiedAt) and supersession (validTo) signals.
  private async collectDocuments(
    ctx: ReadContext,
    paragraphs: readonly Paragraph[],
  ): Promise<Map<DocumentId, Document>> {
    const byId = new Map<DocumentId, Document>();
    const uniqueIds = [...new Set(paragraphs.map((p) => p.documentId))];
    const docs = await this.store.getDocumentsByIds(ctx, uniqueIds);
    for (const doc of docs) byId.set(doc.id, doc);
    return byId;
  }

  private toCandidate(
    paragraph: Paragraph,
    distance: number | null,
    titles: ReadonlyMap<DocumentId, string>,
    fusedRank?: number,
  ): GroundingCandidate {
    const title = titles.get(paragraph.documentId);
    return {
      paragraph,
      distance,
      ...(title !== undefined ? { documentTitle: title } : {}),
      ...(fusedRank !== undefined ? { fusedRank } : {}),
    };
  }
}

// Clamp a blend weight into [0, 1]. Defensive against a misconfigured
// queryDefaults.keywordWeight.
function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// Weighted reciprocal-rank fusion of the vector and keyword result lists. Both
// arrive best-first. A paragraph's fused score is the weighted sum of its RRF
// contribution from each list (1/(RRF_K + position)); paragraphs absent from a
// list simply get no contribution from it. Returns the fused order (capped),
// the per-paragraph fused rank (for grounding order), and the per-paragraph
// method ('keyword' iff surfaced by keyword and NOT by the within-threshold
// vector set — the exact-term lift; else 'vector').
function fuseVectorKeyword(args: {
  vector: readonly ParagraphId[];
  keyword: readonly ParagraphId[];
  keywordWeight: number;
  limit: number;
}): {
  order: ParagraphId[];
  rankById: Map<ParagraphId, number>;
  methodById: Map<ParagraphId, RetrievalMethod>;
  // Raw fused relevance score per paragraph (higher = better). Exposed so a
  // downstream signal (recency) can re-weight it before the final ordering.
  scoreById: Map<ParagraphId, number>;
} {
  const wKw = args.keywordWeight;
  const wSem = 1 - wKw;
  const score = new Map<ParagraphId, number>();
  const add = (id: ParagraphId, contribution: number) =>
    score.set(id, (score.get(id) ?? 0) + contribution);
  args.vector.forEach((id, i) => add(id, wSem * (1 / (RRF_K + i))));
  args.keyword.forEach((id, i) => add(id, wKw * (1 / (RRF_K + i))));

  const inVector = new Set(args.vector);
  const order = [...score.keys()]
    .sort((a, b) => {
      const d = (score.get(b) ?? 0) - (score.get(a) ?? 0);
      // Deterministic tiebreak on id so the fused order is stable run-to-run.
      return d !== 0 ? d : String(a).localeCompare(String(b));
    })
    .slice(0, args.limit);

  const rankById = new Map<ParagraphId, number>();
  const methodById = new Map<ParagraphId, RetrievalMethod>();
  order.forEach((id, i) => {
    rankById.set(id, i);
    methodById.set(id, inVector.has(id) ? 'vector' : 'keyword');
  });
  return { order, rankById, methodById, scoreById: score };
}

// Recency multiplier on a relevance score: a soft, never-zeroing decay so current
// documents outrank stale ones without making old material unreachable. The decay
// is exponential with `halfLifeDays`, floored at RECENCY_FLOOR:
//   multiplier(age) = RECENCY_FLOOR + (1 - RECENCY_FLOOR) · 0.5^(ageDays / halfLife)
// so a brand-new doc scores ×1.0, a doc one half-life old ×0.75, and an ancient
// one asymptotes to ×RECENCY_FLOOR (never 0 → always reachable). halfLifeDays ≤ 0
// disables the signal (×1.0). It is applied ONLY on the open ranking path; the
// entity-gather path is completeness-first and never recency-demoted.
const RECENCY_FLOOR = 0.5;

function recencyMultiplier(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const decay = 0.5 ** (Math.max(0, ageDays) / halfLifeDays); // (0, 1]
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay;
}

function ageInDays(createdAt: Date, nowMs: number): number {
  return (nowMs - createdAt.getTime()) / 86_400_000;
}

// The entity's source paragraph, when it was produced by document extraction.
function paragraphOf(entity: Entity): ParagraphId | null {
  return entity.provenance.kind === 'document_extract' ? entity.provenance.paragraphId : null;
}

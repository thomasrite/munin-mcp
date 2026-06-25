// Query pipeline public types.
//
// The query pipeline answers a free-text question against a tenant's graph
// and returns a grounded answer with parseable citations. Every answer either
// cites at least one paragraph the caller is permitted to see, or honestly
// declines (`no_evidence`). There is no ungrounded-answer path.

import type { ActorId, DocumentId, ParagraphId, TenantId } from '../graph/types';

export interface QueryRequest {
  readonly tenantId: TenantId;
  // The caller's already-expanded access tags. The configuration layer's
  // TagExpander runs upstream of the engine (decisions 5); the engine receives
  // a flat array and uses it for set intersection on every read. An empty
  // array means "this caller sees nothing", never "no filter".
  readonly accessTags: readonly string[];
  readonly question: string;
  // The caller's identity, recorded in query_events telemetry (D2) and used as
  // the read actor. Optional; defaults to a system actor when omitted.
  readonly actor?: ActorId;
}

// One resolved citation. `marker` is the integer that appears as `[n]` in the
// answer text, and is unique within a result. The pipeline guarantees (1.7b):
//   - `paragraphId` was in the visible grounding set (out-of-set citations are
//     dropped);
//   - `quote` is grounded in that paragraph (fabricated quotes are dropped,
//     see faithfulness.ts);
//   - every `[n]` remaining in `answer` has a matching citation here and vice
//     versa (marker↔text reconciliation, see marker-reconcile.ts) — so there
//     are no dangling inline markers and no unused citations.
// Semantic faithfulness ("does the paragraph support the claim?") is a separate
// off-path audit (QueryAuditor), not enforced here.
export interface Citation {
  readonly marker: number;
  readonly paragraphId: ParagraphId;
  readonly documentId: DocumentId;
  // The supporting quote the model attributed to this paragraph. Used by the
  // UI to highlight the relevant span; not verified verbatim in 1.7a
  // (faithfulness checking is 1.7b).
  readonly quote: string;
}

export type QueryStatus = 'answered' | 'no_evidence';

// Completeness disposition for an entity-centric answer (G1 / F31). Present ONLY
// on answers grounded over a GATHERED record set — the engine never asserts
// completeness it did not earn (the open vector path leaves this undefined). When
// present, `note` is non-null iff the gather may have missed unlinked records, and
// it names the subject so the banner is SPECIFIC (not banner-blindness-prone).
export interface AnswerCompleteness {
  // The named subject this answer is about (for the specific banner).
  readonly subject: string;
  // Records gathered for the subject (visible-scoped — never a global total).
  readonly recordCount: number;
  // True only when the answer covers the whole gathered set: the gather was
  // complete-by-construction (key-led, no unlinked remainder) AND every gathered
  // record reached the grounding window. False if records may be unlinked OR the
  // window truncated the gathered set (model saw M of N) — both can hold, and the
  // note reports their union. When false, `note` is set.
  readonly complete: boolean;
  // The specific "may be incomplete" banner text, or null when complete.
  readonly note: string | null;
}

// One side of a surfaced disagreement (P3b). A neutral one-sentence summary of
// the position, the existing citation markers that back it, and a DETERMINISTIC
// disposition: 'current' (the most-authoritative / live side), 'superseded' (a
// side beaten on authority or recency/validity), or null (the engine could not
// distinguish the sides from authority + recency/validity, so it does not guess).
// `disposition` is decided from document metadata + opaque config authority,
// NEVER by the LLM. Every marker here is an existing, permitted Citation.marker.
export interface ContradictionSide {
  readonly summary: string;
  readonly citationMarkers: readonly number[];
  readonly disposition: 'current' | 'superseded' | null;
}

// A surfaced disagreement between the cited sources (P3b). Purely additive — it
// is attached to an ANSWERED result and never alters the answer text or the
// citations. `topic` names what the sources disagree about; `sides` has ≥2
// entries, each backed by ≥1 existing citation.
export interface ContradictionNote {
  readonly topic: string;
  readonly sides: readonly ContradictionSide[];
}

export interface QueryResult {
  readonly status: QueryStatus;
  readonly answer: string;
  readonly citations: readonly Citation[];
  // Set only for entity-centric answers grounded on a gathered set (G1). Absent
  // on the open vector path. Carries the specific completeness banner.
  readonly completeness?: AnswerCompleteness;
  // Set only on an ANSWERED result whose cited sources MATERIALLY DISAGREE (P3b).
  // Purely additive: the answer text + citations are byte-identical with or
  // without this. Absent when there is no disagreement, when detection is off,
  // or when the result is no_evidence. Each side cites existing markers; the
  // authoritative/current side is flagged deterministically (never LLM-judged).
  readonly contradictions?: readonly ContradictionNote[];
}

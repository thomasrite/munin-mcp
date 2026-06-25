// The P3b "sources disagree" machinery — pure and DB-/LLM-free, so it is
// exhaustively unit-testable. The pipeline supplies the cheap LLM call and the
// cited documents; everything here is deterministic.
//
// Flow (the pipeline orchestrates these in order, only on an ANSWERED result
// whose citations span ≥2 distinct documents):
//   1. renderContradictionUserMessage — the detection user turn (tenant content,
//      NEVER cacheable): the grounded answer + each cited source's text.
//   2. parseContradictionInput — defensive parse of the tool output.
//   3. validateConflicts — FAIL-CLOSED: every reported side must be backed by an
//      EXISTING grounded citation; fabricated markers are dropped, and a conflict
//      that loses a side (down to <2) is discarded entirely.
//   4. adjudicateConflicts — DETERMINISTIC disposition (current / superseded /
//      null) from document recency + validity + OPAQUE config authority. Never
//      the LLM: the model describes the sides; the engine decides which is
//      authoritative, from facts it can verify.
//
// The pass NEVER changes the grounded answer text or any citation. It only
// attaches a separate `contradictions` annotation.

import type { AuthorityPolicy } from '@muninhq/shared';

import type { Document, DocumentId } from '../graph/types';
import type { GroundedSource } from './grounding';
import type { Citation, ContradictionNote } from './types';

// --- 1. render -------------------------------------------------------------

// Replace angle brackets with their HTML entities so untrusted paragraph text
// cannot introduce or close a <source>/<answer> tag (mirrors grounding.ts).
function neutraliseAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The detection user turn: the grounded ANSWER plus each cited source's full
// paragraph text, tagged with its citation marker. Carries tenant content, so
// (like the grounding user turn) it is NEVER marked cacheable — the F4 boundary
// is the static system+tool in contradiction-prompt.ts. The model maps its
// findings back to these markers; we then re-validate them in validateConflicts.
export function renderContradictionUserMessage(
  answer: string,
  citations: readonly Citation[],
  sources: readonly GroundedSource[],
): string {
  const textByParagraph = new Map(sources.map((s) => [s.paragraph.id, s.paragraph.text]));
  const lines: string[] = [];
  lines.push('<answer>');
  lines.push(neutraliseAngleBrackets(answer));
  lines.push('</answer>');
  lines.push('');
  lines.push('<sources>');
  const seen = new Set<number>();
  // Marker order is the stable, model-friendly order; citations are already
  // marker-deduped upstream (resolve), so `seen` is belt-and-braces.
  for (const c of [...citations].sort((a, b) => a.marker - b.marker)) {
    if (seen.has(c.marker)) continue;
    seen.add(c.marker);
    // Prefer the full paragraph text (richer context than the span); fall back to
    // the grounded quote if the paragraph is somehow not in the source set.
    const text = textByParagraph.get(c.paragraphId) ?? c.quote;
    lines.push(`<source marker="${c.marker}">\n${neutraliseAngleBrackets(text)}\n</source>`);
  }
  lines.push('</sources>');
  return lines.join('\n');
}

// --- 2. parse --------------------------------------------------------------

export interface RawConflictSide {
  readonly summary: string;
  readonly citationMarkers: readonly number[];
}
export interface RawConflict {
  readonly topic: string;
  readonly sides: readonly RawConflictSide[];
}

// Defensive parse of the tool input. Anthropic constrains the shape at decode
// time via the tool schema; this re-validates as defence-in-depth (same
// discipline as parseAnswerInput / parseRelevance) and narrows the type. A
// malformed payload yields [] (the caller then attaches nothing).
export function parseContradictionInput(input: Readonly<Record<string, unknown>>): RawConflict[] {
  if (!Array.isArray(input.conflicts)) return [];
  const conflicts: RawConflict[] = [];
  for (const rawConflict of input.conflicts) {
    if (rawConflict === null || typeof rawConflict !== 'object') continue;
    const rc = rawConflict as Record<string, unknown>;
    if (typeof rc.topic !== 'string') continue;
    if (!Array.isArray(rc.sides)) continue;
    const sides: RawConflictSide[] = [];
    for (const rawSide of rc.sides) {
      if (rawSide === null || typeof rawSide !== 'object') continue;
      const rs = rawSide as Record<string, unknown>;
      if (typeof rs.summary !== 'string') continue;
      if (!Array.isArray(rs.citationMarkers)) continue;
      const markers: number[] = [];
      for (const m of rs.citationMarkers) {
        if (typeof m === 'number' && Number.isInteger(m)) markers.push(m);
      }
      sides.push({ summary: rs.summary, citationMarkers: markers });
    }
    conflicts.push({ topic: rc.topic, sides });
  }
  return conflicts;
}

// --- 3. validate (fail-closed) ---------------------------------------------

export interface ValidatedSide {
  readonly summary: string;
  // Every marker here is present in the result's citations (deduped).
  readonly citationMarkers: readonly number[];
}
export interface ValidatedConflict {
  readonly topic: string;
  readonly sides: readonly ValidatedSide[];
}

// Validate every reported side against the EXISTING grounded citations — the same
// fail-closed discipline as out-of-set citation dropping (resolve):
//   - drop any citationMarker not present in `citations` (fabricated / out-of-set);
//   - drop any side left with no valid marker, or whose summary is blank;
//   - drop any conflict that does not retain ≥2 sides backed by ≥2 DISTINCT markers
//     (a "side" citing the same single source as another is not a disagreement
//     between sources we can attribute).
// A side never surfaces unless backed by an existing, permitted citation.
export function validateConflicts(
  raw: readonly RawConflict[],
  citations: readonly Citation[],
): ValidatedConflict[] {
  const known = new Set(citations.map((c) => c.marker));
  const out: ValidatedConflict[] = [];
  for (const conflict of raw) {
    const topic = conflict.topic.trim();
    if (topic.length === 0) continue;
    const sides: ValidatedSide[] = [];
    for (const side of conflict.sides) {
      const summary = side.summary.trim();
      if (summary.length === 0) continue;
      const markers = [...new Set(side.citationMarkers.filter((m) => known.has(m)))];
      if (markers.length === 0) continue;
      sides.push({ summary, citationMarkers: markers });
    }
    if (!hasTwoDistinctlyBackedSides(sides)) continue;
    out.push({ topic, sides });
  }
  return out;
}

// A genuine disagreement needs ≥2 sides backed by ≥2 distinct citations overall —
// otherwise it is one source, not two sources in conflict.
function hasTwoDistinctlyBackedSides(sides: readonly ValidatedSide[]): boolean {
  if (sides.length < 2) return false;
  const allMarkers = new Set<number>();
  for (const s of sides) for (const m of s.citationMarkers) allMarkers.add(m);
  return allMarkers.size >= 2;
}

// --- 4. adjudicate (deterministic) -----------------------------------------
//
// Flag which side is current/superseded from facts the engine can VERIFY —
// document recency + version validity + OPAQUE config authority — NEVER from the
// LLM. The model described the sides; the engine decides authority. When the
// sides cannot be distinguished on these signals (e.g. same document, equal
// recency, no authority policy), the disposition is null: we surface the
// disagreement honestly without guessing a winner.

// Per-side adjudication facts, derived from the documents the side cites.
interface SideFacts {
  // Lowest (best) authority rank across the side's documents; +Infinity when no
  // document matches the policy (or no policy is configured).
  readonly authority: number;
  // True iff EVERY cited document of the side is a superseded version (validTo
  // set). A side with at least one live document is not flagged stale here.
  readonly allSuperseded: boolean;
  // Newest real-world modification across the side's documents (epoch ms), or
  // null when none carry a sourceModifiedAt.
  readonly newestMillis: number | null;
}

// A document's authority rank: the index of the FIRST policy token present in its
// access tags (lower = more authoritative), or +Infinity if none match. The
// engine treats the tokens as OPAQUE strings — pure set membership, no parsing.
function authorityRank(doc: Document, policy: AuthorityPolicy | undefined): number {
  if (!policy) return Number.POSITIVE_INFINITY;
  const tags = new Set(doc.accessTags);
  for (let i = 0; i < policy.orderedTags.length; i++) {
    const token = policy.orderedTags[i];
    if (token !== undefined && tags.has(token)) return i;
  }
  return Number.POSITIVE_INFINITY;
}

function sideFacts(
  side: ValidatedSide,
  markerToDoc: ReadonlyMap<number, DocumentId>,
  docById: ReadonlyMap<DocumentId, Document>,
  policy: AuthorityPolicy | undefined,
): SideFacts {
  let authority = Number.POSITIVE_INFINITY;
  let newestMillis: number | null = null;
  let docCount = 0;
  let supersededCount = 0;
  for (const marker of side.citationMarkers) {
    const docId = markerToDoc.get(marker);
    if (!docId) continue;
    const doc = docById.get(docId);
    if (!doc) continue;
    docCount += 1;
    authority = Math.min(authority, authorityRank(doc, policy));
    if (doc.validTo !== null) supersededCount += 1;
    if (doc.sourceModifiedAt) {
      const ms = doc.sourceModifiedAt.getTime();
      newestMillis = newestMillis === null ? ms : Math.max(newestMillis, ms);
    }
  }
  return { authority, allSuperseded: docCount > 0 && supersededCount === docCount, newestMillis };
}

// Total preorder: < 0 when `a` is more current/authoritative than `b`. Order of
// signals is (a) authority, then (b) validity (live beats superseded), then (c)
// real-world recency (newer wins; unknown sorts last). Returns 0 when the two
// sides are indistinguishable on every signal.
function compareSides(a: SideFacts, b: SideFacts): number {
  // (a) authority — lower rank wins. Guarded so Infinity-vs-Infinity → equal (no NaN).
  if (a.authority !== b.authority) return a.authority - b.authority;
  // (b) validity — a live side beats a fully-superseded one.
  if (a.allSuperseded !== b.allSuperseded) return a.allSuperseded ? 1 : -1;
  // (c) recency — newer real-world modification wins; unknown recency sorts last.
  return compareRecency(a.newestMillis, b.newestMillis);
}

function compareRecency(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

// Assign each side a disposition from pairwise comparison (order-independent):
//   - 'superseded' if some other side is strictly more current/authoritative;
//   - 'current'    if it beats some other side and is beaten by none;
//   - null         if it is tied with every other side (indeterminable).
function assignDispositions(facts: readonly SideFacts[]): ('current' | 'superseded' | null)[] {
  return facts.map((self, i) => {
    let betterThanSomeone = false;
    let worseThanSomeone = false;
    for (let j = 0; j < facts.length; j++) {
      if (j === i) continue;
      const other = facts[j];
      if (other === undefined) continue;
      if (compareSides(self, other) < 0) betterThanSomeone = true;
      if (compareSides(other, self) < 0) worseThanSomeone = true;
    }
    if (worseThanSomeone) return 'superseded';
    if (betterThanSomeone) return 'current';
    return null;
  });
}

// Attach a DETERMINISTIC disposition to every side of every validated conflict,
// from the metadata of the already-cited documents (`docs`, fetched by the
// pipeline via the access-filtered getDocumentsByIds) + the opaque config
// authority. The summaries + markers are passed through verbatim — the LLM never
// influences which side is current.
export function adjudicateConflicts(
  validated: readonly ValidatedConflict[],
  citations: readonly Citation[],
  docs: readonly Document[],
  authorityPolicy: AuthorityPolicy | undefined,
): ContradictionNote[] {
  const markerToDoc = new Map<number, DocumentId>(citations.map((c) => [c.marker, c.documentId]));
  const docById = new Map<DocumentId, Document>(docs.map((d) => [d.id, d]));
  return validated.map((conflict) => {
    const facts = conflict.sides.map((s) => sideFacts(s, markerToDoc, docById, authorityPolicy));
    const disp = assignDispositions(facts);
    return {
      topic: conflict.topic,
      sides: conflict.sides.map((s, i) => ({
        summary: s.summary,
        citationMarkers: s.citationMarkers,
        disposition: disp[i] ?? null,
      })),
    };
  });
}

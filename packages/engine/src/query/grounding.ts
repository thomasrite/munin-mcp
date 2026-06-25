// Grounding context assembly — pure, DB- and LLM-free, so it is exhaustively
// unit-testable.
//
// Given the paragraphs retrieved by vector search plus those reached by graph
// expansion, select which ones make the grounding prompt and render them into
// the user-turn message. The selection enforces three bounds so the prompt is
// not filled with marginal material (token-budget decision, 1.7a):
//   1. distance threshold — drop paragraphs less similar than the cutoff;
//   2. count cap         — keep at most `maxParagraphs`;
//   3. token ceiling     — stop once the estimated token total is reached.
//
// Candidates are deduplicated by paragraph id (a paragraph can arrive both
// from vector search and from expansion). Vector hits sort by ascending cosine
// distance; expansion-only paragraphs (no direct distance) sort after all
// vector hits, preserving their input order.

import type { Paragraph, ParagraphId } from '../graph/types';

export interface GroundingCandidate {
  readonly paragraph: Paragraph;
  // Cosine distance from the query vector (0 = identical). null for paragraphs
  // reached only via graph expansion, which have no direct query similarity.
  readonly distance: number | null;
  // Optional human-readable document title for the source label. The pipeline
  // supplies it when cheaply available; absent is fine.
  readonly documentTitle?: string;
  // Hybrid retrieval: an explicit pre-computed selection order (lower = better),
  // set by the caller after fusing vector + keyword results. When present the
  // candidate sorts by this rank AHEAD of any distance-only candidate, and is
  // EXEMPT from the distance threshold (relevance was already gated during
  // fusion — a strong keyword hit must not be dropped for a weak vector distance).
  // Absent → the candidate keeps the legacy distance-based ordering + threshold.
  readonly fusedRank?: number;
}

export interface GroundingOptions {
  // Drop vector hits with distance strictly greater than this. Expansion-only
  // candidates (distance null) are exempt — they earned inclusion structurally.
  readonly distanceThreshold: number;
  readonly maxParagraphs: number;
  // Hard ceiling on the estimated token total of the rendered sources.
  readonly tokenCeiling: number;
}

export interface GroundedSource {
  // Stable label used in the prompt and in the model's citations, e.g. "P1".
  readonly sourceId: string;
  readonly paragraph: Paragraph;
}

export interface GroundingContext {
  // The rendered user-turn message carrying the numbered sources, or null when
  // no candidate survives selection (the caller short-circuits to no_evidence).
  readonly message: string | null;
  // Selected sources in prompt order. The pipeline resolves the model's
  // citations against this set; a citation outside it is rejected.
  readonly sources: readonly GroundedSource[];
}

// Cheap token estimate — chars/4 is the well-known rough heuristic. For
// bounding the grounding context this is good enough and avoids a tokeniser
// dependency; a precise tokeniser is not warranted for budgeting. Deliberately
// conservative-rounding (ceil) so we never undercount.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildGroundingContext(
  question: string,
  candidates: readonly GroundingCandidate[],
  opts: GroundingOptions,
): GroundingContext {
  // 1. Deduplicate by paragraph id, keeping the best (lowest) distance seen.
  const byId = new Map<ParagraphId, GroundingCandidate>();
  for (const cand of candidates) {
    const existing = byId.get(cand.paragraph.id);
    if (!existing) {
      byId.set(cand.paragraph.id, cand);
      continue;
    }
    byId.set(cand.paragraph.id, preferCandidate(existing, cand));
  }

  // 2. Drop vector hits beyond the distance threshold. Expansion-only (distance
  //    null) and fused candidates (relevance already gated during fusion) are exempt.
  const filtered = [...byId.values()].filter(
    (c) => c.fusedRank !== undefined || c.distance === null || c.distance <= opts.distanceThreshold,
  );

  // 3. Sort: vector hits by ascending distance, expansion-only last (stable).
  const sorted = stableSort(filtered, compareCandidates);

  // 4. Apply count cap + token ceiling.
  const selected: GroundedSource[] = [];
  let tokenTotal = 0;
  for (const cand of sorted) {
    if (selected.length >= opts.maxParagraphs) break;
    const sourceId = `P${selected.length + 1}`;
    const rendered = renderSource(sourceId, cand);
    const cost = estimateTokens(rendered);
    // Always admit the first source even if it alone exceeds the ceiling —
    // returning a source is strictly better than silently producing none.
    if (selected.length > 0 && tokenTotal + cost > opts.tokenCeiling) break;
    selected.push({ sourceId, paragraph: cand.paragraph });
    tokenTotal += cost;
  }

  if (selected.length === 0) {
    return { message: null, sources: [] };
  }

  const message = renderMessage(question, selected, byId);
  return { message, sources: selected };
}

function preferCandidate(a: GroundingCandidate, b: GroundingCandidate): GroundingCandidate {
  // A directly-retrieved candidate (carries a fusedRank) always beats an
  // expansion-only duplicate; between two fused, the lower (better) rank.
  if (a.fusedRank !== undefined || b.fusedRank !== undefined) {
    if (a.fusedRank === undefined) return b;
    if (b.fusedRank === undefined) return a;
    return a.fusedRank <= b.fusedRank ? a : b;
  }
  // Otherwise prefer the candidate carrying an actual distance; between two with
  // distances, prefer the smaller. A direct vector hit always beats an
  // expansion-only duplicate of the same paragraph.
  if (a.distance === null) return b;
  if (b.distance === null) return a;
  return b.distance < a.distance ? b : a;
}

function compareCandidates(a: GroundingCandidate, b: GroundingCandidate): number {
  // Hybrid: candidates with an explicit fused rank sort first, by that rank
  // ascending; a candidate without one (expansion) sorts after all fused ones.
  if (a.fusedRank !== undefined || b.fusedRank !== undefined) {
    if (a.fusedRank === undefined) return 1;
    if (b.fusedRank === undefined) return -1;
    return a.fusedRank - b.fusedRank;
  }
  if (a.distance === null && b.distance === null) return 0;
  if (a.distance === null) return 1;
  if (b.distance === null) return -1;
  return a.distance - b.distance;
}

// Each source is wrapped in an XML-ish <source> delimiter the model is trained
// to treat as a structural boundary. Tenant paragraph text is untrusted
// (ingested content could contain prompt-injection attempts), so we neutralise
// any literal angle brackets in it — a paragraph therefore cannot forge or
// close the delimiter and break out of its data context. The system prompt
// (answer-prompt.ts) instructs the model that <source> content is data, never
// instructions.
function renderSource(sourceId: string, cand: GroundingCandidate): string {
  const p = cand.paragraph;
  const attrs = [`id="${sourceId}"`];
  if (cand.documentTitle) attrs.push(`doc="${escapeAttr(cand.documentTitle)}"`);
  if (p.page !== null) attrs.push(`page="${p.page}"`);
  return `<source ${attrs.join(' ')}>\n${neutraliseAngleBrackets(p.text)}\n</source>`;
}

// Replace angle brackets with their HTML entities so untrusted paragraph text
// cannot introduce or close a <source> (or any other) tag. We escape brackets
// rather than stripping them so the text the model reads is otherwise faithful.
function neutraliseAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Document titles derive from ingested document metadata/filenames — untrusted
// content, same trust class as paragraph text. They ride in an attribute, so
// escape the quote and brackets; the escaping (not any assumption about the
// title's origin) is the control that keeps the tag well-formed and unforgeable.
function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMessage(
  question: string,
  selected: readonly GroundedSource[],
  byId: ReadonlyMap<ParagraphId, GroundingCandidate>,
): string {
  const lines: string[] = [];
  lines.push('<sources>');
  for (const src of selected) {
    const cand = byId.get(src.paragraph.id);
    lines.push(renderSource(src.sourceId, cand ?? { paragraph: src.paragraph, distance: null }));
  }
  lines.push('</sources>');
  lines.push('');
  // The question is also user-supplied; keep it clearly separated from the
  // source data above.
  lines.push('<question>');
  lines.push(neutraliseAngleBrackets(question));
  lines.push('</question>');
  return lines.join('\n');
}

// Array.prototype.sort is not guaranteed stable across every engine/version
// for our purposes; we want a documented stable order so expansion-only
// candidates retain input order. Decorate-sort-undecorate on the index.
function stableSort<T>(items: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return items
    .map((value, index) => ({ value, index }))
    .sort((a, b) => {
      const c = cmp(a.value, b.value);
      return c !== 0 ? c : a.index - b.index;
    })
    .map((d) => d.value);
}

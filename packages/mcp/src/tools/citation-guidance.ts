// Citation guidance — the short, STABLE result-level instruction that makes the
// calling model SURFACE grounding in its answer instead of leaving it to be
// reconstructed by log-diving (S2 deliverable 1).
//
// Each retrieval/answer result carries one of these constants in a
// `citationGuidance` field. They are deliberately CONSTANT (never interpolated
// with per-call data), so the structured result text stays clean and stable —
// tests assert their presence; the data fields (sourceId, citations, …) are
// untouched. The calling LLM reads the guidance the same way it reads any tool
// result and cites accordingly.

/**
 * For the source-returning tools (`munin_retrieve_context`,
 * `munin_gather_entity`): the CALLING model synthesises, so this constant is the
 * fail-closed contract it must follow. It (a) forbids supplementing from the
 * model's own training/general knowledge, (b) requires citing each claim with
 * the source's STABLE `citeAs` token (not the per-call `P-n` ordinal), and
 * (c) requires flagging anything the sources do not cover as `[not in memory]`
 * rather than filling the gap. This protects Munin's differentiator — grounded,
 * provenance-tracked, won't-make-it-up — at the one seam where the client model
 * could otherwise blend in its own knowledge.
 */
export const SOURCES_CITATION_GUIDANCE =
  'Answer ONLY from the sources below. Do NOT add facts, names, dates, figures, ' +
  'or references from your own training or general knowledge — even ones you are ' +
  'confident are correct. After each claim, cite the source it rests on using ' +
  "that source's stable citeAs token in square brackets — e.g. " +
  '"…rooted in doughnut economics [S1a2b3c4d5e6]" (the per-call sourceId such as ' +
  'P1 is only a within-this-result ordinal; cite citeAs so the reference still ' +
  'resolves across calls). If the sources do not cover part of the question, say ' +
  'so plainly and mark anything you cannot ground as [not in memory] rather than ' +
  'filling the gap from prior knowledge. An uncited claim is a bug.';

/**
 * For `munin_ask`: the answer was synthesised server-side with `[n]` markers
 * mapped to `citations[n]`. Tell the model to preserve them, and to relay an
 * honest `no_evidence` without softening it.
 */
export const ASK_CITATION_GUIDANCE =
  'This answer is grounded server-side: each [n] marker maps to the matching ' +
  'entry in citations[] (its documentId, paragraphId, quoted text and stable ' +
  'citeAs token). Keep the [n] markers when you relay the answer so the user can ' +
  'see the grounding. Each citation also carries a citeAs token (the SAME stable ' +
  'identifier the source-returning tools use), so a source cited here resolves to ' +
  'the same reference if you cite it across calls or alongside ' +
  'munin_retrieve_context / munin_gather_entity. If status is "no_evidence", this ' +
  'memory holds no supporting source — report that plainly and do not substitute ' +
  'your own knowledge.';

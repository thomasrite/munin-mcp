// Marker↔text reconciliation.
//
// The model returns answer text with inline [n] markers plus a citations array
// keyed by the same n. After citation filtering (out-of-set rejection,
// quote-grounding), the two can fall out of sync:
//   - a citation whose marker never appears in the text is unused → drop it;
//   - an inline [n] with no surviving citation is a dangling/orphan marker →
//     strip it from the rendered text so the UI never shows a [n] that links
//     nowhere.
// This guarantees the rendered answer and the citation list are always mutually
// consistent. Pure and deterministic — no DB, no LLM.

export interface MarkerCitation {
  readonly marker: number;
}

export interface Reconciled<C extends MarkerCitation> {
  readonly answer: string;
  readonly citations: readonly C[];
}

// Matches a citation marker like [1] or [12]. We intentionally do not match
// [1, 2] or [1-3]; the answer-prompt instructs single-integer markers, and a
// stray multi-marker form simply won't be recognised (its citations become
// "unused" and drop, which is the safe outcome).
const MARKER_RE = /\[(\d+)\]/g;

export function reconcileMarkers<C extends MarkerCitation>(
  answer: string,
  citations: readonly C[],
): Reconciled<C> {
  const markersInText = new Set<number>();
  for (const m of answer.matchAll(MARKER_RE)) {
    markersInText.add(Number(m[1]));
  }

  // Drop citations whose marker never appears in the answer text.
  const usedCitations = citations.filter((c) => markersInText.has(c.marker));
  const survivingMarkers = new Set(usedCitations.map((c) => c.marker));

  // Strip orphan markers (present in text, no surviving citation) from the text.
  const cleanedAnswer = stripOrphanMarkers(answer, survivingMarkers);

  return { answer: cleanedAnswer, citations: usedCitations };
}

function stripOrphanMarkers(answer: string, surviving: ReadonlySet<number>): string {
  // Remove orphan "[n]" tokens.
  let removed = false;
  const withoutOrphans = answer.replace(MARKER_RE, (full, digits: string) => {
    if (surviving.has(Number(digits))) return full;
    removed = true;
    return '';
  });
  // Only tidy spacing when we actually removed a marker, so the cleanup regexes
  // can never rewrite spacing in an answer that had no orphans (e.g. legitimate
  // " ?" spacing the model produced).
  if (!removed) return answer;
  return (
    withoutOrphans
      // collapse a space left before punctuation: "Q3 ." → "Q3."
      .replace(/\s+([.,;:!?])/g, '$1')
      // collapse doubled spaces created by removal
      .replace(/[ \t]{2,}/g, ' ')
      // tidy space before a newline
      .replace(/[ \t]+\n/g, '\n')
      .trim()
  );
}

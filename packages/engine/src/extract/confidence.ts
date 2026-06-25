// Verbatim-match confidence heuristic.
//
// If every primitive value of an extracted entity's properties appears
// literally in the source paragraph, confidence = 1.0 (Claude copied the
// values). Otherwise confidence = null (Claude inferred, paraphrased, or
// synthesised — we don't claim to know how confident to be).
//
// This is the v1 default per decisions.md entry 16. We deliberately do not
// ask Claude for a confidence score; models calibrate poorly. The
// verbatim heuristic is mechanical, cheap, and honest about what it
// measures (literal copying), without pretending to measure semantic
// confidence.
//
// THIS EMITS THE VERBATIM HEURISTIC ONLY: 1.0 means "copied exactly", NEVER
// "factually correct" — a 1.0 fact can still be semantically wrong (negation,
// mis-attribution, etc.). Measured base rate + the only consumer (inline
// highlighting, which re-checks with word boundaries) in
// the design notes.

export function computeVerbatimConfidence(
  properties: Readonly<Record<string, unknown>>,
  paragraphText: string,
): number | null {
  const haystack = paragraphText.toLowerCase();
  const values = collectStringValues(properties);
  if (values.length === 0) return null;
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length < 3) continue; // skip "ok", "no", noise.
    if (!haystack.includes(trimmed.toLowerCase())) {
      return null;
    }
  }
  return 1.0;
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectStringValues);
  }
  return [];
}

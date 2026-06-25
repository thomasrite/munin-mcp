// Quote-grounding — the hot-path, deterministic faithfulness check.
//
// 1.7a gated citations on the paragraph id being in the visible grounding set,
// but never checked the model's `quote` against the paragraph text — a model
// could attribute a fabricated quote to a real, visible source. This closes
// that gap: a citation survives only if its quote is actually grounded in the
// cited paragraph.
//
// WHAT THIS IS (and is not): a cheap, mechanical, fail-closed check that the
// quote is a (near-)verbatim span of the paragraph. It defends against
// invention and recombination:
//   - invention: a quote whose words are not in the paragraph is rejected;
//   - recombination: a quote stitched from phrases that never appear
//     contiguously is rejected (we require a single contiguous run, not an
//     unordered bag of n-grams).
// It is NOT a semantic-misrepresentation guard: a quote that drops a "not" or
// otherwise selectively omits/negates while staying a near-contiguous span can
// still pass. Catching that requires understanding meaning, which is the job of
// the off-path LLM QueryAuditor (decisions 18). Do not treat this as proof the
// quote fairly represents the source — only that it was lifted from it.
//
// Matching is tolerant of whitespace/punctuation/case (models reflow quotes)
// but not of word order or gaps: after normalisation we accept either a
// verbatim substring, or a single contiguous run of the quote's tokens that
// covers at least `runThreshold` of the quote.

export interface QuoteGroundingOptions {
  // Minimum fraction of the quote's tokens that must appear as ONE contiguous
  // run inside the paragraph for a non-substring match to count as grounded.
  // Default 0.8 — high enough to reject recombination and most selective
  // omission, low enough to tolerate a reflowed leading/trailing token.
  readonly runThreshold?: number;
}

const DEFAULT_RUN_THRESHOLD = 0.8;

export function verifyQuoteGrounding(
  quote: string,
  paragraphText: string,
  opts: QuoteGroundingOptions = {},
): boolean {
  const threshold = opts.runThreshold ?? DEFAULT_RUN_THRESHOLD;
  const normQuote = normalise(quote);
  const normPara = normalise(paragraphText);

  // An empty/whitespace/punctuation-only quote grounds nothing.
  if (normQuote.length === 0) return false;

  // Exact-ish: the whole quote appears verbatim (modulo whitespace/punct/case).
  if (normPara.includes(normQuote)) return true;

  const quoteTokens = normQuote.split(' ').filter((t) => t.length > 0);
  const paraTokens = normPara.split(' ').filter((t) => t.length > 0);
  if (quoteTokens.length === 0) return false;

  // Longest contiguous run of quote tokens that appears as a contiguous
  // subsequence of the paragraph tokens. Requiring contiguity (rather than an
  // unordered n-gram set) is what rejects recombination and most negation: a
  // dropped/added word in the middle breaks the run.
  const longestRun = longestContiguousRun(quoteTokens, paraTokens);
  return longestRun / quoteTokens.length >= threshold;
}

// Lowercase, strip punctuation to spaces, collapse whitespace. Keeps letters
// and digits (and unicode letters) so dates/figures survive.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Length of the longest run of `needle` tokens that occurs contiguously, in
// order, somewhere in `haystack`. O(n*m) which is fine for quote-vs-paragraph
// sizes.
function longestContiguousRun(needle: readonly string[], haystack: readonly string[]): number {
  let best = 0;
  for (let i = 0; i < needle.length; i++) {
    for (let j = 0; j < haystack.length; j++) {
      let k = 0;
      while (
        i + k < needle.length &&
        j + k < haystack.length &&
        needle[i + k] === haystack[j + k]
      ) {
        k++;
      }
      if (k > best) best = k;
    }
  }
  return best;
}

import { describe, expect, it } from 'vitest';

import { verifyQuoteGrounding } from './faithfulness';

const PARA =
  'The Apollo project is led by Sarah Jones and is scheduled to ship in the third quarter of 2026, pending board sign-off.';

describe('verifyQuoteGrounding', () => {
  it('accepts a verbatim quote', () => {
    expect(verifyQuoteGrounding('scheduled to ship in the third quarter', PARA)).toBe(true);
  });

  it('accepts a quote differing only in case/whitespace/punctuation', () => {
    expect(verifyQuoteGrounding('  Sarah   JONES, ', PARA)).toBe(true);
    expect(verifyQuoteGrounding('ship in the THIRD quarter of 2026.', PARA)).toBe(true);
  });

  it('accepts a contiguous near-verbatim run with a reflowed trailing token', () => {
    // Verbatim contiguous span "led by Sarah Jones and is scheduled to ship"
    // (>=0.8 of the quote) with one trailing extra token reflowed off.
    expect(verifyQuoteGrounding('led by Sarah Jones and is scheduled to ship soon', PARA)).toBe(
      true,
    );
  });

  it('rejects a fabricated quote not in the paragraph', () => {
    expect(verifyQuoteGrounding('the budget was cut by forty percent', PARA)).toBe(false);
  });

  it('rejects an empty or punctuation-only quote', () => {
    expect(verifyQuoteGrounding('', PARA)).toBe(false);
    expect(verifyQuoteGrounding('   ...  ', PARA)).toBe(false);
  });

  it('rejects a short quote whose words are not contiguous in the source', () => {
    expect(verifyQuoteGrounding('Jones Apollo', PARA)).toBe(false);
  });

  it('rejects a recombined quote stitched from non-contiguous phrases', () => {
    // Each phrase exists in PARA, but never contiguously as written.
    expect(verifyQuoteGrounding('Sarah Jones pending board sign-off', PARA)).toBe(false);
  });

  it('rejects a meaning-inverting quote that drops a negation', () => {
    const para = 'The merger was not approved by the board in 2026.';
    // "was approved by the board in 2026" breaks contiguity at the dropped "not".
    expect(verifyQuoteGrounding('the merger was approved by the board in 2026', para)).toBe(false);
  });

  it('respects a custom run threshold', () => {
    // 4-token contiguous run "is led by Sarah" out of an 8-token quote = 0.5.
    const quote = 'is led by Sarah completely invented words here';
    expect(verifyQuoteGrounding(quote, PARA, { runThreshold: 0.8 })).toBe(false);
    expect(verifyQuoteGrounding(quote, PARA, { runThreshold: 0.4 })).toBe(true);
  });
});

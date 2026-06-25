import { describe, expect, it } from 'vitest';

import { computeVerbatimConfidence } from './confidence';

describe('computeVerbatimConfidence', () => {
  it('returns 1.0 when every property value appears literally in the paragraph', () => {
    const para = 'The Atlas project began in March 2026 led by Sarah Chen.';
    const result = computeVerbatimConfidence({ name: 'Atlas', lead: 'Sarah Chen' }, para);
    expect(result).toBe(1.0);
  });

  it('returns null when any value is inferred / paraphrased', () => {
    const para = 'The project began in March 2026.';
    const result = computeVerbatimConfidence(
      { name: 'Codename Apollo', description: 'project began in March 2026' },
      para,
    );
    expect(result).toBeNull();
  });

  it('case-insensitive matching', () => {
    const para = 'The atlas project began.';
    const result = computeVerbatimConfidence({ name: 'Atlas' }, para);
    expect(result).toBe(1.0);
  });

  it('numeric and boolean values stringified for matching', () => {
    const para = 'The score was 42 and the test passed.';
    expect(computeVerbatimConfidence({ score: 42 }, para)).toBe(1.0);
  });

  it('returns null on empty property set', () => {
    expect(computeVerbatimConfidence({}, 'anything')).toBeNull();
  });

  it('skips very short string values (noise)', () => {
    const para = 'A is true. We did things.';
    const result = computeVerbatimConfidence({ code: 'A', name: 'things' }, para);
    // Short values are skipped; 'things' is in the paragraph; result 1.0
    expect(result).toBe(1.0);
  });

  it('nested objects flatten correctly', () => {
    const para = 'Sarah Chen, head of finance.';
    expect(
      computeVerbatimConfidence({ person: { name: 'Sarah Chen', role: 'head of finance' } }, para),
    ).toBe(1.0);
  });
});

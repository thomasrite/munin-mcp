import { describe, expect, it } from 'vitest';

import { cosineSimilarity } from './semantic-dedup';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });
  it('is 1 for parallel (scaled) vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [5, 0, 0])).toBeCloseTo(1, 10);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });
  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
  });
  it('returns 0 when either vector is the zero vector (no direction)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

// Unit tests for the per-model pricing table. No DB — pure arithmetic over
// the RATES constants.

import { describe, expect, it } from 'vitest';

import {
  estimateCallCostPence,
  estimateUncachedCostPence,
  getModelPricing,
  isModelPriced,
} from './pricing';

const HAIKU = 'claude-haiku-4-5-20251001';

describe('pricing', () => {
  it('prices the dev cost-control model (Haiku 4.5)', () => {
    // Regression guard for the cost-meter bug: Haiku was missing from RATES,
    // so every Haiku call fell to the all-zeros fallback and reported £0.
    expect(isModelPriced(HAIKU)).toBe(true);

    const p = getModelPricing(HAIKU);
    expect(p.inputPencePerMillion).toBe(79); // ~$1/M × 0.79
    expect(p.cacheCreatePencePerMillion).toBe(99); // ~$1.25/M
    expect(p.cacheReadPencePerMillion).toBe(8); // ~$0.10/M
    expect(p.outputPencePerMillion).toBe(395); // ~$5/M
  });

  it('estimates a non-zero cost for a Haiku call', () => {
    const cost = estimateCallCostPence({
      modelId: HAIKU,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    });
    // 79 (input) + 395 (output) = 474 pence; must not collapse to the £0 fallback.
    expect(cost).toBe(474);
    expect(cost).toBeGreaterThan(0);
  });

  it('counts cache reads at the cheap rate for Haiku', () => {
    const cost = estimateCallCostPence({
      modelId: HAIKU,
      inputTokens: 0,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBe(8); // cache-read rate
  });

  it('values the uncached counterfactual above the cached cost for Haiku', () => {
    const params = {
      modelId: HAIKU,
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    };
    // Cached: 79 (input) + 8 (cache read) = 87. Uncached: 2M × 79 = 158.
    expect(estimateCallCostPence(params)).toBe(87);
    expect(estimateUncachedCostPence(params)).toBe(158);
  });

  it('falls back to zero for an unknown model', () => {
    expect(isModelPriced('some-unknown-model')).toBe(false);
    expect(
      estimateCallCostPence({
        modelId: 'some-unknown-model',
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBe(0);
  });
});

// Per-model pricing constants for cache-cost analysis.
//
// Numbers are in pence (×100) so we can keep integer maths and avoid float
// rounding in operator-facing reports. Update when pricing changes; pricing
// is reviewed when a new model is added to the default set.
//
// Sources:
//   - Anthropic public pricing as of the model's GA date
//   - Provider region pricing where it diverges (Bedrock eu-west-2 may
//     differ; recorded in the per-region overrides map when Phase 5
//     measures it)

export interface ModelPricing {
  // Pence per million tokens. Stored as integers; convert to £ at display.
  readonly inputPencePerMillion: number; // standard, non-cached input
  readonly cacheCreatePencePerMillion: number; // cache_creation_input_tokens
  readonly cacheReadPencePerMillion: number; // cache_read_input_tokens
  readonly outputPencePerMillion: number;
}

// One pence = 1/100 £. £3/M → 300 pence/M.
// USD → GBP at a conservative 0.79 (rough mid-2025); revisit periodically.
// For "cost saved" reporting, the relative ratios matter more than the
// absolute values; the user sees both raw and saved.
const RATES: Readonly<Record<string, ModelPricing>> = {
  // Claude Sonnet 4.6 (default extraction model)
  'claude-sonnet-4-6': {
    inputPencePerMillion: 237, // ~$3/M × 0.79
    cacheCreatePencePerMillion: 296, // ~$3.75/M (ephemeral 1.25×); extended ~$6/M tracked via tier below
    cacheReadPencePerMillion: 24, // ~$0.30/M (0.1× of input)
    outputPencePerMillion: 1184, // ~$15/M
  },
  // Claude Opus 4.7 (override path for synthesis-heavy queries)
  'claude-opus-4-7': {
    inputPencePerMillion: 1185, // ~$15/M
    cacheCreatePencePerMillion: 1481, // ~$18.75/M
    cacheReadPencePerMillion: 118, // ~$1.50/M
    outputPencePerMillion: 5925, // ~$75/M
  },
  // Claude Haiku 4.5 (MUNIN_DEV_MODE=haiku cost-control model)
  'claude-haiku-4-5-20251001': {
    inputPencePerMillion: 79, // ~$1/M × 0.79
    cacheCreatePencePerMillion: 99, // ~$1.25/M (ephemeral 1.25×)
    cacheReadPencePerMillion: 8, // ~$0.10/M (0.1× of input)
    outputPencePerMillion: 395, // ~$5/M
  },
  // OpenAI text-embedding-3-small (dev embedding)
  'text-embedding-3-small': {
    inputPencePerMillion: 16, // ~$0.02/M
    cacheCreatePencePerMillion: 16, // no cache distinction for embeddings
    cacheReadPencePerMillion: 16,
    outputPencePerMillion: 0,
  },
  // Amazon Titan Text Embeddings v2 (Bedrock eu-west-2 production embedding).
  // Same ~$0.02/M tier as OpenAI 3-small; kept equal so the two are comparable
  // in the cost report (relative ratios matter more than absolutes — see header).
  'amazon.titan-embed-text-v2:0': {
    inputPencePerMillion: 16, // ~$0.02/M
    cacheCreatePencePerMillion: 16, // no cache distinction for embeddings
    cacheReadPencePerMillion: 16,
    outputPencePerMillion: 0,
  },
};

// Bedrock (eu-west-2) Claude calls record the CANONICAL model id ('claude-sonnet-4-6',
// 'claude-haiku-4-5-20251001', 'claude-opus-4-7') in telemetry — so they reuse the
// Claude rates above; the `llm_calls.region` column ('eu-west-2') distinguishes
// them from the US dev path. Bedrock eu-west-2 list prices track Anthropic's
// public rates closely enough for the ballpark report.

const FALLBACK: ModelPricing = {
  inputPencePerMillion: 0,
  cacheCreatePencePerMillion: 0,
  cacheReadPencePerMillion: 0,
  outputPencePerMillion: 0,
};

export function getModelPricing(modelId: string): ModelPricing {
  return RATES[modelId] ?? FALLBACK;
}

export function isModelPriced(modelId: string): boolean {
  return modelId in RATES;
}

// Estimated cost of a single LLM call in pence.
// Note: inputTokens already includes both regular input AND
// cache_creation_input_tokens (per AnthropicLLMProvider's summing).
// We don't have a way to separate them after the fact, so we treat the
// whole inputTokens at the regular rate. This slightly under-states cost
// when caching is active (cache creation is 1.25× regular). Acceptable for
// a ballpark; for exact accounting we'd need a separate column.
export function estimateCallCostPence(params: {
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const p = getModelPricing(params.modelId);
  const inputCost = (params.inputTokens * p.inputPencePerMillion) / 1_000_000;
  const cachedCost = (params.cachedInputTokens * p.cacheReadPencePerMillion) / 1_000_000;
  const outputCost = (params.outputTokens * p.outputPencePerMillion) / 1_000_000;
  return Math.round(inputCost + cachedCost + outputCost);
}

// What the call would have cost if caching had not been in play — every
// input token, including the ones served from cache, billed at the regular
// rate.
export function estimateUncachedCostPence(params: {
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const p = getModelPricing(params.modelId);
  const totalInput = params.inputTokens + params.cachedInputTokens;
  const inputCost = (totalInput * p.inputPencePerMillion) / 1_000_000;
  const outputCost = (params.outputTokens * p.outputPencePerMillion) / 1_000_000;
  return Math.round(inputCost + outputCost);
}

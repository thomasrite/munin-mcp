// Cache report — aggregates llm_calls into a cost / hit-rate summary for
// operators and cost analysts.
//
// Output covers each purpose ('extraction' | 'query' | 'embedding' |
// 'generation' | 'other') and shows: call count, cached vs uncached input
// tokens, hit rate, estimated cost in pence, and the "savings" — what it
// would have cost if caching had not been in play.

import { and, between, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { llmCalls } from '../db/schema';
import type { TenantId } from '../graph/types';
import { estimateCallCostPence, estimateUncachedCostPence, isModelPriced } from './pricing';

export interface CacheReportInput {
  readonly tenantId: TenantId;
  readonly from: Date;
  readonly to: Date;
  readonly purpose?: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
}

export interface PurposeReport {
  readonly purpose: string;
  readonly callCount: number;
  readonly inputTokens: number; // non-cached input + cache creation
  readonly cachedInputTokens: number; // cache reads
  readonly outputTokens: number;
  readonly cacheHitRate: number; // cached / (cached + input)
  readonly estimatedCostPence: number; // actual cost with caching
  readonly estimatedUncachedCostPence: number;
  readonly savedPence: number;
  readonly savedPercentage: number;
  readonly modelsSeen: readonly string[];
  readonly modelsWithoutPricing: readonly string[];
}

export interface CacheReport {
  readonly tenantId: TenantId;
  readonly from: string;
  readonly to: string;
  readonly byPurpose: readonly PurposeReport[];
  readonly totals: Omit<PurposeReport, 'purpose'>;
}

export async function generateCacheReport(
  db: PostgresJsDatabase,
  input: CacheReportInput,
): Promise<CacheReport> {
  const filters = [
    eq(llmCalls.tenantId, input.tenantId),
    between(llmCalls.occurredAt, input.from, input.to),
  ];
  if (input.purpose) filters.push(eq(llmCalls.purpose, input.purpose));

  const rows = await db
    .select({
      purpose: llmCalls.purpose,
      modelId: llmCalls.modelId,
      inputTokens: llmCalls.inputTokens,
      cachedInputTokens: llmCalls.cachedInputTokens,
      outputTokens: llmCalls.outputTokens,
    })
    .from(llmCalls)
    .where(and(...filters));

  // Group by purpose.
  const byPurpose = new Map<string, MutablePurposeReport>();
  for (const row of rows) {
    const key = row.purpose;
    let agg = byPurpose.get(key);
    if (!agg) {
      agg = newPurposeReport(key);
      byPurpose.set(key, agg);
    }
    accumulate(agg, row);
  }

  // Compute totals across purposes.
  const totals = newPurposeReport('TOTAL');
  for (const row of rows) accumulate(totals, row);

  const purposeReports = Array.from(byPurpose.values()).map(finalise);
  // Sort: largest cost first.
  purposeReports.sort((a, b) => b.estimatedCostPence - a.estimatedCostPence);

  return {
    tenantId: input.tenantId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    byPurpose: purposeReports,
    totals: finalise(totals),
  };
}

// --- internals -------------------------------------------------------------

interface MutablePurposeReport {
  purpose: string;
  callCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedCostPence: number;
  estimatedUncachedCostPence: number;
  modelsSeen: Set<string>;
  modelsWithoutPricing: Set<string>;
}

function newPurposeReport(purpose: string): MutablePurposeReport {
  return {
    purpose,
    callCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    estimatedCostPence: 0,
    estimatedUncachedCostPence: 0,
    modelsSeen: new Set(),
    modelsWithoutPricing: new Set(),
  };
}

function accumulate(
  agg: MutablePurposeReport,
  row: {
    modelId: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  },
): void {
  agg.callCount++;
  agg.inputTokens += row.inputTokens;
  agg.cachedInputTokens += row.cachedInputTokens;
  agg.outputTokens += row.outputTokens;
  agg.modelsSeen.add(row.modelId);
  if (!isModelPriced(row.modelId)) {
    agg.modelsWithoutPricing.add(row.modelId);
  }
  agg.estimatedCostPence += estimateCallCostPence({
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
  });
  agg.estimatedUncachedCostPence += estimateUncachedCostPence({
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
  });
}

function finalise(agg: MutablePurposeReport): PurposeReport {
  const totalInput = agg.inputTokens + agg.cachedInputTokens;
  const cacheHitRate = totalInput === 0 ? 0 : agg.cachedInputTokens / totalInput;
  const saved = agg.estimatedUncachedCostPence - agg.estimatedCostPence;
  const savedPercentage =
    agg.estimatedUncachedCostPence === 0 ? 0 : saved / agg.estimatedUncachedCostPence;
  return {
    purpose: agg.purpose,
    callCount: agg.callCount,
    inputTokens: agg.inputTokens,
    cachedInputTokens: agg.cachedInputTokens,
    outputTokens: agg.outputTokens,
    cacheHitRate,
    estimatedCostPence: agg.estimatedCostPence,
    estimatedUncachedCostPence: agg.estimatedUncachedCostPence,
    savedPence: saved,
    savedPercentage,
    modelsSeen: Array.from(agg.modelsSeen).sort(),
    modelsWithoutPricing: Array.from(agg.modelsWithoutPricing).sort(),
  };
}

// Reference unused import so the build keeps the schema in lockstep.
void sql;

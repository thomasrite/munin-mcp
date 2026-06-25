// Residency report — aggregates llm_calls region telemetry into the evidence
// the G3-5 residency checklist asserts: which regions every recorded AI call
// went to, by purpose, with first/last timestamps.
//
// DELIBERATELY CROSS-TENANT: the report reads region/purpose/count rows only
// (never content, never tenant-scoped data beyond the aggregate), because the
// residency question is "did ANY call leave the permitted region" — a
// per-deployment property, not a per-tenant one. This is the same content-free
// telemetry surface the cache report reads; access to it is an operator
// concern, enforced at the database-credential level, not via accessTags
// (there is no graph read here).

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { llmCalls } from '../db/schema';

export interface ResidencyReportInput {
  /** Regions considered compliant (e.g. ['eu-west-2', 'stub']). Empty/omitted = report only, no verdict. */
  readonly allowedRegions?: readonly string[];
}

export interface RegionUsage {
  readonly region: string;
  readonly purpose: string;
  readonly calls: number;
  readonly firstCall: string;
  readonly lastCall: string;
}

export interface ResidencyReport {
  readonly rows: readonly RegionUsage[];
  /** Rows whose region is outside allowedRegions (empty when no allowlist given). */
  readonly violations: readonly RegionUsage[];
  readonly totalCalls: number;
}

export async function generateResidencyReport(
  db: PostgresJsDatabase,
  input: ResidencyReportInput = {},
): Promise<ResidencyReport> {
  const grouped = await db
    .select({
      region: llmCalls.region,
      purpose: llmCalls.purpose,
      calls: sql<number>`count(*)::int`,
      firstCall: sql<string>`min(${llmCalls.occurredAt})::text`,
      lastCall: sql<string>`max(${llmCalls.occurredAt})::text`,
    })
    .from(llmCalls)
    .groupBy(llmCalls.region, llmCalls.purpose)
    .orderBy(llmCalls.region, llmCalls.purpose);

  const rows: RegionUsage[] = grouped.map((r) => ({
    region: r.region,
    purpose: r.purpose,
    calls: r.calls,
    firstCall: r.firstCall,
    lastCall: r.lastCall,
  }));
  const allowed = new Set(input.allowedRegions ?? []);
  const violations = allowed.size > 0 ? rows.filter((r) => !allowed.has(r.region)) : [];
  return {
    rows,
    violations,
    totalCalls: rows.reduce((n, r) => n + r.calls, 0),
  };
}

// Integration test for the cache report. Real Postgres via testcontainers,
// fake llm_calls rows seeded with deterministic token counts so the
// arithmetic is straightforward to verify.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { llmCalls, tenants } from '../db/schema';
import { asTenantId } from '../graph/types';
import { generateCacheReport } from './cache-report';

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000ca6e1');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000ca6e2');

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'cache-report-tenant-A' },
    { id: TENANT_B, name: 'cache-report-tenant-B' },
  ]);
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE llm_calls RESTART IDENTITY`);
});

async function seed(
  rows: Array<{
    tenantId: string;
    purpose: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
    modelId: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    occurredAt: Date;
  }>,
): Promise<void> {
  for (const r of rows) {
    await db.insert(llmCalls).values({
      id: crypto.randomUUID(),
      tenantId: r.tenantId,
      purpose: r.purpose,
      modelId: r.modelId,
      inputTokens: r.inputTokens,
      cachedInputTokens: r.cachedInputTokens,
      outputTokens: r.outputTokens,
      latencyMs: 1,
      region: 'test',
      metadata: {},
      occurredAt: r.occurredAt,
    });
  }
}

describe('cache report', () => {
  it('aggregates calls by purpose, computes hit rate, computes savings', async () => {
    const now = new Date();
    await seed([
      // Extraction: 10 cache hits at 5000 tokens each = 50k cached, plus 5k creation
      {
        tenantId: TENANT_A,
        purpose: 'extraction',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 5000,
        cachedInputTokens: 0,
        outputTokens: 100,
        occurredAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
      ...Array.from({ length: 9 }, () => ({
        tenantId: TENANT_A,
        purpose: 'extraction' as const,
        modelId: 'claude-sonnet-4-6',
        inputTokens: 100,
        cachedInputTokens: 5000,
        outputTokens: 100,
        occurredAt: new Date(now.getTime() - 60 * 60 * 1000),
      })),
    ]);

    const report = await generateCacheReport(db, {
      tenantId: TENANT_A,
      from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      to: now,
    });

    expect(report.byPurpose.length).toBe(1);
    const extraction = report.byPurpose[0]!;
    expect(extraction.purpose).toBe('extraction');
    expect(extraction.callCount).toBe(10);
    expect(extraction.inputTokens).toBe(5000 + 9 * 100); // 5900
    expect(extraction.cachedInputTokens).toBe(9 * 5000); // 45000
    expect(extraction.outputTokens).toBe(10 * 100);
    // Hit rate = cached / (input + cached) = 45000 / (5900 + 45000)
    expect(extraction.cacheHitRate).toBeCloseTo(45000 / 50900, 4);
    expect(extraction.estimatedCostPence).toBeGreaterThan(0);
    expect(extraction.estimatedUncachedCostPence).toBeGreaterThan(extraction.estimatedCostPence);
    expect(extraction.savedPence).toBeGreaterThan(0);
    expect(extraction.modelsSeen).toEqual(['claude-sonnet-4-6']);
    expect(extraction.modelsWithoutPricing).toEqual([]);
  });

  it('filters by tenant — tenant B sees only its own calls', async () => {
    const now = new Date();
    await seed([
      {
        tenantId: TENANT_A,
        purpose: 'extraction',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
        occurredAt: now,
      },
      {
        tenantId: TENANT_B,
        purpose: 'extraction',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 200,
        cachedInputTokens: 0,
        outputTokens: 20,
        occurredAt: now,
      },
    ]);
    const reportA = await generateCacheReport(db, {
      tenantId: TENANT_A,
      from: new Date(now.getTime() - 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    });
    expect(reportA.byPurpose[0]?.inputTokens).toBe(100);

    const reportB = await generateCacheReport(db, {
      tenantId: TENANT_B,
      from: new Date(now.getTime() - 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    });
    expect(reportB.byPurpose[0]?.inputTokens).toBe(200);
  });

  it('respects the date window — calls outside [from, to] are excluded', async () => {
    const now = new Date();
    await seed([
      {
        tenantId: TENANT_A,
        purpose: 'extraction',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 999,
        cachedInputTokens: 0,
        outputTokens: 99,
        occurredAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      },
      {
        tenantId: TENANT_A,
        purpose: 'extraction',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 111,
        cachedInputTokens: 0,
        outputTokens: 11,
        occurredAt: now,
      },
    ]);
    const report = await generateCacheReport(db, {
      tenantId: TENANT_A,
      from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    });
    expect(report.byPurpose[0]?.inputTokens).toBe(111);
  });

  it('aggregates across purposes and reports a TOTAL', async () => {
    const now = new Date();
    await seed([
      {
        tenantId: TENANT_A,
        purpose: 'extraction',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 1000,
        cachedInputTokens: 4000,
        outputTokens: 200,
        occurredAt: now,
      },
      {
        tenantId: TENANT_A,
        purpose: 'embedding',
        modelId: 'text-embedding-3-small',
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        occurredAt: now,
      },
    ]);
    const report = await generateCacheReport(db, {
      tenantId: TENANT_A,
      from: new Date(now.getTime() - 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    });
    expect(report.byPurpose.length).toBe(2);
    expect(report.totals.callCount).toBe(2);
    expect(report.totals.inputTokens).toBe(1500);
    expect(report.totals.cachedInputTokens).toBe(4000);
  });

  it("buckets and filters the 'generation' purpose (migration 0010 enum value)", async () => {
    // Proves the migration applied (the enum accepts 'generation' on insert),
    // that generation spend gets its own bucket (no longer hidden in 'other'),
    // and that the report's --purpose filter accepts the new value.
    const now = new Date();
    await seed([
      {
        tenantId: TENANT_A,
        purpose: 'generation',
        modelId: 'claude-opus-4-7',
        inputTokens: 2000,
        cachedInputTokens: 0,
        outputTokens: 500,
        occurredAt: now,
      },
      {
        tenantId: TENANT_A,
        purpose: 'query',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
        occurredAt: now,
      },
    ]);

    const window = {
      from: new Date(now.getTime() - 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    };

    // Unfiltered: a distinct 'generation' bucket exists with a real cost.
    const all = await generateCacheReport(db, { tenantId: TENANT_A, ...window });
    const generation = all.byPurpose.find((p) => p.purpose === 'generation');
    expect(generation).toBeDefined();
    expect(generation!.callCount).toBe(1);
    expect(generation!.estimatedCostPence).toBeGreaterThan(0);

    // Filtered: --purpose generation returns only the generation row.
    const filtered = await generateCacheReport(db, {
      tenantId: TENANT_A,
      ...window,
      purpose: 'generation',
    });
    expect(filtered.byPurpose.length).toBe(1);
    expect(filtered.byPurpose[0]!.purpose).toBe('generation');
    expect(filtered.byPurpose[0]!.callCount).toBe(1);
  });

  it('flags models without pricing constants', async () => {
    const now = new Date();
    await seed([
      {
        tenantId: TENANT_A,
        purpose: 'other',
        modelId: 'made-up-model',
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 0,
        occurredAt: now,
      },
    ]);
    const report = await generateCacheReport(db, {
      tenantId: TENANT_A,
      from: new Date(now.getTime() - 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    });
    expect(report.byPurpose[0]?.modelsWithoutPricing).toContain('made-up-model');
    // Unknown model → cost calculated at zero, so saved == 0
    expect(report.byPurpose[0]?.estimatedCostPence).toBe(0);
    expect(report.byPurpose[0]?.savedPence).toBe(0);
  });

  it('handles empty result set', async () => {
    const now = new Date();
    const report = await generateCacheReport(db, {
      tenantId: TENANT_A,
      from: new Date(now.getTime() - 60 * 1000),
      to: now,
    });
    expect(report.byPurpose).toEqual([]);
    expect(report.totals.callCount).toBe(0);
  });
});

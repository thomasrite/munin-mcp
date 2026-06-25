// Integration test for the residency report (G3-5 evidence harness). Real
// Postgres via testcontainers; llm_calls rows seeded across regions/purposes;
// asserts the grouping and — the part the checklist relies on — that a
// non-permitted region surfaces as a violation.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { llmCalls, tenants } from '../db/schema';
import { asTenantId } from '../graph/types';
import { generateResidencyReport } from './residency-report';

const TENANT_A = asTenantId('00000000-0000-0000-0000-000000e51de1');
const TENANT_B = asTenantId('00000000-0000-0000-0000-000000e51de2');

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'residency-tenant-A' },
    { id: TENANT_B, name: 'residency-tenant-B' },
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
    purpose: 'extraction' | 'query' | 'embedding';
    region: string;
  }>,
): Promise<void> {
  for (const r of rows) {
    await db.insert(llmCalls).values({
      id: crypto.randomUUID(),
      tenantId: r.tenantId,
      purpose: r.purpose,
      modelId: 'test-model',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      latencyMs: 1,
      region: r.region,
      metadata: {},
      occurredAt: new Date(),
    });
  }
}

describe('residency report', () => {
  it('groups calls by region × purpose ACROSS tenants (deployment-level evidence)', async () => {
    await seed([
      { tenantId: TENANT_A, purpose: 'query', region: 'eu-west-2' },
      { tenantId: TENANT_B, purpose: 'query', region: 'eu-west-2' },
      { tenantId: TENANT_A, purpose: 'embedding', region: 'eu-west-2' },
      { tenantId: TENANT_A, purpose: 'extraction', region: 'stub' },
    ]);
    const report = await generateResidencyReport(db);
    expect(report.totalCalls).toBe(4);
    expect(report.rows).toHaveLength(3); // (eu-west-2 × query), (eu-west-2 × embedding), (stub × extraction)
    const queryRow = report.rows.find((r) => r.region === 'eu-west-2' && r.purpose === 'query');
    expect(queryRow?.calls).toBe(2); // both tenants counted
    expect(report.violations).toHaveLength(0); // no allowlist given → report-only
  });

  it('flags any region outside the allowlist as a violation (the checklist assertion)', async () => {
    await seed([
      { tenantId: TENANT_A, purpose: 'query', region: 'eu-west-2' },
      { tenantId: TENANT_A, purpose: 'embedding', region: 'stub' },
      { tenantId: TENANT_B, purpose: 'query', region: 'us-east-1' }, // the leak
    ]);
    const report = await generateResidencyReport(db, {
      allowedRegions: ['eu-west-2', 'stub'],
    });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.region).toBe('us-east-1');
    expect(report.violations[0]?.calls).toBe(1);
  });

  it('a fully-compliant table yields zero violations under the eu-west-2 allowlist', async () => {
    await seed([
      { tenantId: TENANT_A, purpose: 'query', region: 'eu-west-2' },
      { tenantId: TENANT_A, purpose: 'extraction', region: 'eu-west-2' },
    ]);
    const report = await generateResidencyReport(db, { allowedRegions: ['eu-west-2'] });
    expect(report.violations).toHaveLength(0);
    expect(report.totalCalls).toBe(2);
  });
});

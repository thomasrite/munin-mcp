// `pnpm --filter munin-mcp cache:report` — operator-facing summary of LLM call
// cost and cache hit rate for a tenant over a date window.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { type TenantId, asTenantId } from '@muninhq/engine';
import { type CacheReport, type PurposeReport, generateCacheReport } from '@muninhq/engine/cost';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

interface CliArgs {
  readonly tenantId: TenantId;
  readonly from: Date;
  readonly to: Date;
  readonly purpose?: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
  readonly format: 'json' | 'human';
}

function parseArgs(argv: readonly string[]): CliArgs {
  let tenantId: string | undefined;
  let fromRaw: string | undefined;
  let toRaw: string | undefined;
  let purpose: CliArgs['purpose'] | undefined;
  let format: 'json' | 'human' = 'human';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '-t') {
      tenantId = argv[++i];
    } else if (arg === '--from') {
      fromRaw = argv[++i];
    } else if (arg === '--to') {
      toRaw = argv[++i];
    } else if (arg === '--purpose') {
      const v = argv[++i];
      if (
        v === 'extraction' ||
        v === 'query' ||
        v === 'embedding' ||
        v === 'generation' ||
        v === 'other'
      ) {
        purpose = v;
      } else {
        throw new Error(
          '--purpose must be one of: extraction, query, embedding, generation, other',
        );
      }
    } else if (arg === '--json') {
      format = 'json';
    }
  }

  if (!tenantId) {
    throw new Error(
      'usage: cache:report --tenant <uuid> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--purpose extraction|query|embedding|generation|other] [--json]',
    );
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = fromRaw ? new Date(fromRaw) : defaultFrom;
  const to = toRaw ? new Date(toRaw) : now;
  if (Number.isNaN(from.getTime())) throw new Error(`invalid --from: ${fromRaw}`);
  if (Number.isNaN(to.getTime())) throw new Error(`invalid --to: ${toRaw}`);
  if (from > to) throw new Error('--from must not be after --to');

  return {
    tenantId: asTenantId(tenantId),
    from,
    to,
    ...(purpose !== undefined ? { purpose } : {}),
    format,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://munin:munin@localhost:5432/munin';
  const client = postgres(connectionString, { max: 5 });
  const db: PostgresJsDatabase = drizzle(client);
  try {
    const report = await generateCacheReport(db, {
      tenantId: args.tenantId,
      from: args.from,
      to: args.to,
      ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
    });
    if (args.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHuman(report);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

function printHuman(report: CacheReport): void {
  const lines: string[] = [];
  lines.push(`Cache report — tenant ${report.tenantId}`);
  lines.push(`Window: ${report.from} → ${report.to}`);
  lines.push('');
  for (const p of report.byPurpose) lines.push(...renderPurpose(p));
  if (report.byPurpose.length > 1) {
    lines.push('---');
    lines.push(...renderPurpose({ ...report.totals, purpose: 'TOTAL' }));
  }
  if (report.byPurpose.some((p) => p.modelsWithoutPricing.length > 0)) {
    lines.push('');
    lines.push(
      'Note: some models lack pricing constants in src/cost/pricing.ts — their cost estimates are zero. ' +
        'Update RATES when a new model is added to the default set.',
    );
  }
  console.log(lines.join('\n'));
}

function renderPurpose(p: PurposeReport): string[] {
  const lines: string[] = [];
  const hitPct = (p.cacheHitRate * 100).toFixed(1);
  const savedPct = (p.savedPercentage * 100).toFixed(1);
  const actual = (p.estimatedCostPence / 100).toFixed(2);
  const uncached = (p.estimatedUncachedCostPence / 100).toFixed(2);
  const saved = (p.savedPence / 100).toFixed(2);
  lines.push(`[${p.purpose}]`);
  lines.push(`  Calls:               ${p.callCount.toLocaleString()}`);
  lines.push(`  Input tokens:        ${p.inputTokens.toLocaleString()}`);
  lines.push(`  Cached input tokens: ${p.cachedInputTokens.toLocaleString()}`);
  lines.push(`  Output tokens:       ${p.outputTokens.toLocaleString()}`);
  lines.push(`  Cache hit rate:      ${hitPct}%`);
  lines.push(`  Estimated cost:      £${actual}`);
  lines.push(`  If uncached:         £${uncached}`);
  lines.push(`  Saved by caching:    £${saved} (${savedPct}%)`);
  if (p.modelsSeen.length > 0) {
    lines.push(`  Models:              ${p.modelsSeen.join(', ')}`);
  }
  lines.push('');
  return lines;
}

main().catch((err) => {
  console.error('cache:report failed:', err);
  process.exit(1);
});

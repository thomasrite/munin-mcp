// `pnpm --filter munin-mcp residency:report` — operator-facing evidence that
// every recorded AI call stayed in the permitted region (G3-5 residency
// verification harness).
//
//   residency:report [--require <region>] [--allow-stub] [--json]
//
// Thin wrapper over `generateResidencyReport` (@muninhq/engine/cost — the same
// shape as cache:report): the engine aggregates the per-call
// `llm_calls.region` telemetry; this CLI parses args and formats. With
// --require, exits non-zero if any call's region is outside the allowed set —
// so the residency checklist can assert, not eyeball. --allow-stub
// additionally permits the 'stub' region (zero-spend test calls).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { generateResidencyReport } from '@muninhq/engine/cost';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

interface CliArgs {
  readonly requireRegion?: string;
  readonly allowStub: boolean;
  readonly format: 'json' | 'human';
}

function parseArgs(argv: readonly string[]): CliArgs {
  let requireRegion: string | undefined;
  let allowStub = false;
  let format: 'json' | 'human' = 'human';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--require') requireRegion = argv[++i];
    else if (arg === '--allow-stub') allowStub = true;
    else if (arg === '--json') format = 'json';
  }
  return { ...(requireRegion ? { requireRegion } : {}), allowStub, format };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL ?? 'postgres://munin:munin@localhost:5432/munin';
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  try {
    const allowedRegions = args.requireRegion
      ? [args.requireRegion, ...(args.allowStub ? ['stub'] : [])]
      : [];
    const report = await generateResidencyReport(db, { allowedRegions });

    if (args.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.rows.length === 0) {
        console.log('llm_calls is empty — no AI calls recorded yet.');
      }
      for (const r of report.rows) {
        console.log(
          `${r.region.padEnd(12)} ${r.purpose.padEnd(12)} ${String(r.calls).padStart(8)} calls   ${r.firstCall} → ${r.lastCall}`,
        );
      }
      if (args.requireRegion) {
        if (report.violations.length === 0) {
          console.log(
            `\n✔ every recorded call is within: ${allowedRegions.join(', ')} (${report.totalCalls} calls total)`,
          );
        } else {
          console.error(`\n✘ ${report.violations.length} region group(s) OUTSIDE the allowed set:`);
          for (const v of report.violations) {
            console.error(`  ${v.region} (${v.purpose}): ${v.calls} calls`);
          }
        }
      }
    }
    if (report.violations.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('residency report failed:', err);
  process.exit(1);
});

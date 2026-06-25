// `pnpm --filter munin-mcp retention:sweep --tenant <uuid>` — run the
// data-retention sweep ONCE for a tenant (G2a: the F55 feedback leg + the
// F54 resolved-review-item leg).
//
// Local mode has no cron, so this is the local/operator entry point; hosted
// deployments run the `retention_sweep` graphile job instead (same engine
// orchestrator either way — and note no recurring hosted schedule enqueues it
// yet). Scrub-in-place only: content is NULLed past the TTL,
// the row skeleton + decision trail survive, one content-free audit row per
// run. Idempotent — re-running scrubs nothing new.
//
// TTLs from env: MUNIN_FEEDBACK_RETENTION_DAYS / MUNIN_REVIEW_RETENTION_DAYS
// (both default 90, provisional pending the DPO/DPIA conversation —
//).
//
// Backend routing matches ingest/query/extract: GRAPH_STORE=local opens PGlite,
// the default is node-postgres against DATABASE_URL.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

import {
  RETENTION_SWEEP_ACTOR,
  type TenantId,
  asTenantId,
  feedbackRetentionDays,
  retentionCutoff,
  reviewRetentionDays,
  runRetentionSweep,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

function parseArgs(argv: readonly string[]): { tenantId: TenantId } {
  let tenantId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '-t') {
      tenantId = argv[++i];
    }
  }
  if (!tenantId) {
    throw new Error('--tenant <uuid> is required');
  }
  return { tenantId: asTenantId(tenantId) };
}

async function main(): Promise<void> {
  const { tenantId } = parseArgs(process.argv.slice(2));

  // Preserve the localhost dev default for the Postgres path; the factory reads
  // DATABASE_URL (same pre-seed as ingest/query/extract-cli).
  process.env.DATABASE_URL ??= 'postgres://munin:munin@localhost:5432/munin';

  const feedbackDays = feedbackRetentionDays();
  const reviewDays = reviewRetentionDays();
  const handle = await loadGraphStore();
  try {
    const result = await runRetentionSweep(
      handle.db,
      { tenantId, actor: RETENTION_SWEEP_ACTOR },
      {
        feedbackCutoff: retentionCutoff(feedbackDays),
        reviewCutoff: retentionCutoff(reviewDays),
      },
    );
    // Content-free counts only — never content.
    console.log(
      `retention sweep complete for tenant ${tenantId}: ` +
        `${result.feedbackScrubbed} feedback row(s) scrubbed (TTL ${feedbackDays}d), ` +
        `${result.reviewItemsScrubbed} resolved review item(s) scrubbed (TTL ${reviewDays}d)`,
    );
  } finally {
    await handle.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('retention sweep failed:', err);
    process.exit(1);
  },
);

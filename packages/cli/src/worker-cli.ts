// `pnpm --filter munin-mcp worker` — standalone graphile-worker process.
//
// Thin runnable wrapper. The worker LOGIC (provider load, handler registration,
// the graphile-worker main loop) lives in the engine as `startWorker`
// (`@muninhq/engine/jobs`); this entry point only reads env and invokes it.
// Production (Phase 5) wires its own start command against the same library
// function — no hosted assumptions live here.
//
// Extraction needs a Configuration, resolved via `EXTRACTION_CONFIG_PACKAGE`
// (e.g. @muninhq/config-generic-demo). If unset, the extract_paragraphs handler
// is not registered and only embedding jobs run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

import { loadConfigurationWithResolver } from '@muninhq/engine';
import { startWorker } from '@muninhq/engine/jobs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://munin:munin@localhost:5432/munin';
  const extractionPkg = process.env.EXTRACTION_CONFIG_PACKAGE;
  // Resolve the config package in THIS CLI's context (F20), then hand the engine
  // a pre-resolved Configuration — the engine never imports config packages.
  const extractionConfiguration = extractionPkg
    ? await loadConfigurationWithResolver(extractionPkg, (p) => import(p))
    : undefined;
  console.log(`worker starting against ${url}`);
  await startWorker({
    connectionString: url,
    ...(extractionConfiguration ? { extractionConfiguration } : {}),
  });
}

main().catch((err) => {
  console.error('worker exited with error:', err);
  process.exit(1);
});

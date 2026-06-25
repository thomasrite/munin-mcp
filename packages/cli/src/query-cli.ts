// `pnpm --filter munin-mcp query` — ask the query pipeline a question as an
// operator.
//
//   pnpm --filter munin-mcp query --tenant <uuid> --tags <a,b> "<question>"
//
// Loads the configuration from EXTRACTION_CONFIG_PACKAGE (required — no
// default), expands the caller's base tags through the configuration's
// tagExpansion, applies the configuration's recommended query-pipeline
// retrieval defaults (F-L1), runs the QueryPipeline, and prints the grounded
// answer with resolved citations. Generic: no vertical concepts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Configuration } from '@muninhq/shared';
import { config as loadEnv } from 'dotenv';

import {
  QueryPipeline,
  type ReadContext,
  type TenantId,
  asActorId,
  asTenantId,
  loadConfigurationWithResolver,
  loadProvidersFromEnv,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';

import { queryOptionsFromConfig } from './query-defaults';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

interface CliArgs {
  readonly tenantId: TenantId;
  readonly baseTags: readonly string[];
  readonly question: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let tenantId: string | undefined;
  let baseTags: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '-t') tenantId = argv[++i];
    else if (arg === '--tags')
      baseTags = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    // reason: loop index is in bounds, so arg is defined despite noUncheckedIndexedAccess.
    else rest.push(arg as string);
  }
  if (!tenantId) throw new Error('--tenant <uuid> is required');
  const question = rest.join(' ').trim();
  if (!question) throw new Error('a question is required (positional argument)');
  return { tenantId: asTenantId(tenantId), baseTags, question };
}

function loadConfiguration(): Promise<Configuration> {
  const pkg = process.env.EXTRACTION_CONFIG_PACKAGE;
  if (!pkg?.trim()) {
    throw new Error(
      'EXTRACTION_CONFIG_PACKAGE is required (e.g. @muninhq/config-generic-demo). ' +
        'There is no default configuration — set it explicitly so the query layer expands tags and applies retrieval defaults from the right configuration.',
    );
  }
  // Resolve in this CLI's module context (F20) — the package is the CLI's
  // devDependency, not resolvable from the engine.
  return loadConfigurationWithResolver(pkg, (p) => import(p));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Preserve the localhost dev default for the Postgres path; the factory reads
  // DATABASE_URL. With GRAPH_STORE=local this is ignored and PGlite is used.
  process.env.DATABASE_URL ??= 'postgres://munin:munin@localhost:5432/munin';
  const { store: graphStore, close } = await loadGraphStore();
  try {
    const configuration = await loadConfiguration();
    const providers = loadProvidersFromEnv();

    const accessTags = await Promise.resolve(
      configuration.tagExpansion(args.baseTags, { tenantId: args.tenantId }),
    );

    const pipeline = new QueryPipeline({
      graphStore,
      llmProvider: providers.llm,
      embeddingProvider: providers.embedding,
      ...queryOptionsFromConfig(configuration),
    });
    const result = await pipeline.answer({
      tenantId: args.tenantId,
      accessTags,
      question: args.question,
      actor: asActorId('cli:query'),
    });

    const ctx: ReadContext = {
      kind: 'regular',
      tenantId: args.tenantId,
      accessTags,
      actor: asActorId('cli:query'),
    };

    /* eslint-disable no-console */
    console.log(`\nstatus: ${result.status}`);
    console.log(`\n${result.answer}\n`);
    if (result.citations.length > 0) {
      console.log('citations:');
      for (const c of result.citations) {
        const doc = await graphStore.getDocument(ctx, c.documentId);
        const where = doc ? doc.title : c.documentId;
        console.log(`  [${c.marker}] ${where} — "${c.quote}"`);
      }
    }
    /* eslint-enable no-console */
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('query failed:', err);
  process.exit(1);
});

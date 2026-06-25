// `pnpm engine ingest <dir>` — CLI ingester for local development.
//
// Reads DATABASE_URL and blob-storage env, constructs the pipeline,
// runs the filesystem connector against the given directory, prints a
// summary at the end. Embedding jobs are enqueued but the worker
// process must be running separately (`pnpm engine worker`) for them
// to be processed.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';

import { filesystemConnector } from '@muninhq/connector-filesystem';
import {
  type IngestSummary,
  IngestionPipeline,
  type TenantId,
  asTenantId,
  loadBlobStorageFromEnv,
  loadEmbeddingProvider,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import { InlineEmbedRunner } from '@muninhq/engine/jobs';

import { IngestDirectoryError, mapConnectorReadError, resolveIngestDirectory } from './ingest-path';
import { preflightLocalStoreLock, reportLocalStoreError } from './local-store-errors';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

interface CliArgs {
  readonly directory: string;
  readonly tenantId: TenantId;
  readonly accessTags: readonly string[];
  readonly forceReingest: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let directory: string | undefined;
  let tenantId: string | undefined;
  let accessTagsRaw = '';
  let forceReingest = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '-t') {
      tenantId = argv[++i];
    } else if (arg === '--tags') {
      accessTagsRaw = argv[++i] ?? '';
    } else if (arg === '--force-reingest') {
      forceReingest = true;
    } else if (arg && !arg.startsWith('-') && directory === undefined) {
      directory = arg;
    }
  }

  if (!directory) {
    throw new Error(
      'usage: ingest <directory> --tenant <uuid> [--tags tag1,tag2] [--force-reingest]',
    );
  }
  if (!tenantId) {
    throw new Error('--tenant <uuid> is required');
  }
  const accessTags = accessTagsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (accessTags.length === 0) {
    throw new Error('--tags is required (comma-separated list, at least one)');
  }

  return {
    // Pre-flight the path here (literal-then-trimmed, existence-checked) instead
    // of a bare `path.resolve` — a missing/space-padded dir gets a product-framed
    // error at the CLI boundary, not a raw ENOENT deep in the connector walk.
    directory: resolveIngestDirectory(directory),
    tenantId: asTenantId(tenantId),
    accessTags,
    forceReingest,
  };
}

// Runnable core: env is whatever the caller has already loaded into process.env
// (the repo .env for the direct entrypoint below; $MUNIN_HOME/munin.env for the
// `munin ingest` wrapper). Does NOT load any .env itself. Returns the ingest
// summary so callers (e.g. the setup wizard) can tell how many NEW documents were
// added this run — every existing caller may ignore it.
export async function runIngest(
  argv: readonly string[] = process.argv.slice(2),
): Promise<IngestSummary> {
  const args = parseArgs(argv);
  // Local-mode pre-flight: if the user's AI client already holds the single-
  // process PGlite store, refuse UP FRONT with friendly guidance rather than
  // letting the WASM open throw a scary error after the fact (no-op otherwise).
  preflightLocalStoreLock();
  // Preserve the localhost dev default for the Postgres path; the factory reads
  // DATABASE_URL. With GRAPH_STORE=local this is ignored and PGlite is used.
  process.env.DATABASE_URL ??= 'postgres://munin:munin@localhost:5432/munin';

  // Backend (Postgres | PGlite) and blobs (Azure | filesystem) are env-selected.
  const { store: graphStore, close } = await loadGraphStore();
  const blobStorage = loadBlobStorageFromEnv();

  // Jobs: JOBS=inline runs embedding in-process (local, no worker); otherwise the
  // batches are enqueued to graphile-worker over DATABASE_URL.
  const jobsMode = (process.env.JOBS ?? 'worker').toLowerCase();
  let embedEnqueuer: InlineEmbedRunner | undefined;
  let embeddingModelId: string;
  if (jobsMode === 'inline') {
    const embeddingProvider = loadEmbeddingProvider();
    embedEnqueuer = new InlineEmbedRunner({ graphStore, embeddingProvider });
    embeddingModelId = embeddingProvider.modelId;
  } else {
    embeddingModelId = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  }

  const pipeline = new IngestionPipeline({
    graphStore,
    blobStorage,
    embeddingModelId,
    ...(embedEnqueuer ? { embedEnqueuer } : { jobConnectionString: process.env.DATABASE_URL }),
  });

  try {
    const summary = await pipeline.ingest({
      tenantId: args.tenantId,
      connector: filesystemConnector,
      connectorConfig: { rootPath: args.directory, recursive: true },
      accessTags: args.accessTags,
      forceReingest: args.forceReingest,
    });
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (err) {
    // Map the connector's raw "cannot read directory" ENOENT (a root that
    // vanished/became unreadable after the pre-flight) to the same friendly
    // path guidance; rethrow everything else untouched.
    const mapped = mapConnectorReadError(err);
    if (mapped) throw mapped;
    throw err;
  } finally {
    await close();
  }
}

// Direct entrypoint (`pnpm --filter munin-mcp ingest …`): the repo-root .env is
// authoritative for the dev workflow. When imported as a module (the `munin
// ingest` wrapper) this block is skipped, so the home env is not overridden.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv({ path: path.join(repoRoot, '.env'), override: true });
  runIngest().catch((err) => {
    // A bad ingest path carries its own product-framed guidance — print it as-is.
    if (err instanceof IngestDirectoryError) console.error(err.message);
    // F71: the local store being locked/corrupt is an EXPECTED hazard of the
    // local flow — friendly line, no raw WASM stack. Everything else is a real
    // failure and prints the error.
    else if (!reportLocalStoreError(err, { dataDir: process.env.PGLITE_DATA_DIR }))
      console.error('ingest failed:', err);
    process.exit(1);
  });
}

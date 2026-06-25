// `pnpm --filter munin-mcp extract` CLI.
//
// Two subcommands:
//   pnpm --filter munin-mcp extract --tenant <uuid> [--re-extract]
//   pnpm --filter munin-mcp extract:status --tenant <uuid>
//
// Both load the configuration from `EXTRACTION_CONFIG_PACKAGE` (required — no
// default). The "extract" command runs extraction via one of two job modes
// (the same JOBS switch ingest uses): `JOBS=worker` (default) enqueues
// `extract_paragraphs` jobs for an active graphile worker; `JOBS=inline` runs
// extraction synchronously in-process (the local/PGlite path — F44 — and handy
// for tiny Postgres corpora too). The "status" command reports paragraph
// counts against the current schemaHash so an operator can see staleness.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Configuration, computeSchemaHash } from '@muninhq/shared';
import { config as loadEnv } from 'dotenv';

import {
  type ParagraphId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  internalBypass,
  loadConfigurationWithResolver,
  loadLlmProvider,
  resolveExtractionModelId,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';
// Zero-dependency leaf — the canonical set of source-code extensions (also
// re-exported by @muninhq/connector-filesystem). Used below to skip code-derived
// paragraphs from extraction.
import { CODE_FILE_EXTENSIONS } from '@muninhq/engine/ingest/extensions';
import {
  InlineExtractRunner,
  batchForExtraction,
  enqueueExtractParagraphs,
  withWorkerUtils,
} from '@muninhq/engine/jobs';

import { preflightLocalStoreLock, reportLocalStoreError } from './local-store-errors';

// System maintenance: the extract CLI has no calling user. Pending-paragraph
// discovery reads under bypass (tenant isolation preserved); stale-schema
// cleanup is a write (writes carry no access tags).
const ACTOR = asActorId('system:extract-cli');
const bypassRead = (tenantId: TenantId): ReadContext => ({
  kind: 'bypass',
  tenantId,
  bypass: internalBypass(
    'extract-cli.maintenance',
    'system extraction maintenance: discover paragraphs needing extraction',
  ),
  actor: ACTOR,
});
const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

interface CliArgs {
  readonly subcommand: 'extract' | 'status';
  readonly tenantId: TenantId;
  readonly reExtract: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  // First positional arg is the subcommand (default: extract).
  let subcommand: 'extract' | 'status' = 'extract';
  let tenantId: string | undefined;
  let reExtract = false;
  let i = 0;
  const first = argv[0];
  if (first === 'status' || first === 'extract') {
    subcommand = first;
    i = 1;
  }
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '-t') {
      tenantId = argv[++i];
    } else if (arg === '--re-extract') {
      reExtract = true;
    }
  }
  if (!tenantId) {
    throw new Error('--tenant <uuid> is required');
  }
  return { subcommand, tenantId: asTenantId(tenantId), reExtract };
}

function loadConfiguration(): Promise<Configuration> {
  const pkg = process.env.EXTRACTION_CONFIG_PACKAGE;
  if (!pkg?.trim()) {
    throw new Error(
      'EXTRACTION_CONFIG_PACKAGE is required (e.g. @muninhq/config-generic-demo). ' +
        'There is no default configuration — set it explicitly so extraction is never run against the wrong schema.',
    );
  }
  // Resolve in this CLI's module context (F20) — the package is the CLI's
  // devDependency, not resolvable from the engine.
  return loadConfigurationWithResolver(pkg, (p) => import(p));
}

// Lowercased code-extension set, built once from the engine's allowlist.
const CODE_EXTENSION_SET: ReadonlySet<string> = new Set(
  CODE_FILE_EXTENSIONS.map((e) => e.toLowerCase()),
);

/**
 * True when a document's source file is code (its file extension is in the
 * engine's CODE_FILE_EXTENSIONS allowlist). The filesystem connector stores the
 * relative file path in BOTH externalId and title, so either yields the
 * extension — prefer externalId. Pure — unit-tested.
 */
export function isCodeDocument(
  doc: { readonly title: string; readonly externalId: string | null },
  codeExtensions: ReadonlySet<string> = CODE_EXTENSION_SET,
): boolean {
  const name = doc.externalId ?? doc.title;
  return codeExtensions.has(path.extname(name).toLowerCase());
}

/**
 * Split pending paragraphs into the ones to extract (`keep`) and a count of
 * code-derived ones dropped (`skippedCodeCount`), given the source documents.
 * A prose-oriented extraction schema yields ~no entities from source code, so
 * extracting it is pure LLM spend/time — and retrieval already works on the
 * inline embeddings. This is a CLI-tier filter over
 * the already-built pending list: it uses ONLY existing reader output
 * (paragraph.documentId → getDocumentsByIds), never an engine selection-query
 * change. Pure — unit-tested.
 */
export function partitionPendingByCode<
  TPara extends { readonly documentId: string },
  TDoc extends { readonly id: string; readonly title: string; readonly externalId: string | null },
>(
  pending: readonly TPara[],
  documents: readonly TDoc[],
  codeExtensions: ReadonlySet<string> = CODE_EXTENSION_SET,
): { keep: TPara[]; skippedCodeCount: number } {
  const codeDocIds = new Set<string>();
  for (const doc of documents) {
    if (isCodeDocument(doc, codeExtensions)) codeDocIds.add(doc.id);
  }
  const keep: TPara[] = [];
  let skippedCodeCount = 0;
  for (const p of pending) {
    if (codeDocIds.has(p.documentId)) skippedCodeCount++;
    else keep.push(p);
  }
  return { keep, skippedCodeCount };
}

async function runExtract(args: CliArgs): Promise<void> {
  // Preserve the localhost dev default for the Postgres path; the factory reads
  // DATABASE_URL (same pre-seed as ingest/query-cli).
  process.env.DATABASE_URL ??= 'postgres://munin:munin@localhost:5432/munin';
  const connectionString = process.env.DATABASE_URL;
  // Backend-selected store (F44): GRAPH_STORE=local opens PGlite, the default
  // stays node-postgres — same routing as ingest/query-cli. The inline leg
  // (JOBS=inline → InlineExtractRunner) has shipped and builds the local graph
  // in-process; only the JOBS=worker + GRAPH_STORE=local combo is refused below,
  // because the ENQUEUE path talks graphile-worker over the Postgres
  // DATABASE_URL, which a PGlite store does not run — enqueueing into a
  // DIFFERENT database than the one just scanned would silently strand the jobs.
  const { store, close } = await loadGraphStore();
  try {
    const configuration = await loadConfiguration();
    const schemaHash = computeSchemaHash(configuration);

    if (args.reExtract) {
      // Clear extractions produced under any superseded schema; current-schema
      // output is left in place. After this, every paragraph that lacks a
      // current-schema extraction (including the ones we just cleared) is
      // surfaced by findParagraphsPendingExtraction below and re-enqueued.
      const removed = await store.softDeleteExtractionsBySchema(writeCtx(args.tenantId), {
        keepSchemaHash: schemaHash,
      });
      console.log(
        `re-extract: cleared ${removed.entitiesDeleted} stale-schema entities, ${removed.edgesDeleted} edges`,
      );
    }

    // Paragraphs with no live entity under the current schema.
    const pending = await store.findParagraphsPendingExtraction(bypassRead(args.tenantId), {
      schemaHash,
    });

    // Skip code-derived paragraphs (CLI-tier filter — no engine change): resolve
    // each pending paragraph's source document via existing readers and drop the
    // ones whose file extension is code. Code yields ~no entities under a prose
    // schema, so extracting it is wasted LLM spend/time; retrieval is unaffected
    // because embeddings run inline at ingest.
    const pendingDocIds = [...new Set(pending.map((p) => p.documentId))];
    const pendingDocs =
      pendingDocIds.length > 0
        ? await store.getDocumentsByIds(bypassRead(args.tenantId), pendingDocIds)
        : [];
    const { keep, skippedCodeCount } = partitionPendingByCode(pending, pendingDocs);
    const paragraphIds = keep.map((p) => p.id as ParagraphId);

    if (paragraphIds.length === 0) {
      console.log(
        skippedCodeCount > 0
          ? `no paragraphs require extraction under the current schema (skipped ${skippedCodeCount} code-file paragraph(s) — code yields no entities under a prose schema; retrieval still works on embeddings alone)`
          : 'no paragraphs require extraction under the current schema',
      );
      return;
    }

    // Up-front, before any LLM work: state the scope and that retrieval does NOT
    // depend on this. Extraction is OPTIONAL — embeddings (computed inline at
    // ingest) already power retrieval/search; this only builds the entity graph
    // for gather/dossier features. State it plainly so the user makes an informed
    // choice, especially on a large or local corpus where the run is slow.
    console.log(
      `${paragraphIds.length} paragraph(s) pending extraction under the current schema${
        skippedCodeCount > 0 ? ` (skipped ${skippedCodeCount} code-file paragraph(s))` : ''
      }.`,
    );
    console.log(
      'Retrieval already works without this — embeddings run at ingest. Extraction builds the entity graph (gather/dossier features) on top.',
    );

    // Jobs: the SAME switch ingest-cli uses. JOBS=inline runs extraction
    // synchronously in-process (works on BOTH stores — the local/PGlite path,
    // and useful for tiny Postgres corpora); JOBS=worker (default) enqueues to
    // graphile-worker over DATABASE_URL.
    const jobsMode = (process.env.JOBS ?? 'worker').toLowerCase();
    if (jobsMode === 'inline') {
      // Inline extraction is synchronous and single-process: it HOLDS the local
      // store for the whole run, so warn before the (potentially long) work.
      console.log(
        'This runs in-process and holds your local memory while it works — do not open your AI client until it finishes.',
      );
      const llmProvider = loadLlmProvider();
      const cacheTierEnv = (process.env.EXTRACTION_CACHE_TIER ?? 'ephemeral').toLowerCase();
      const cacheTier: 'ephemeral' | 'extended' =
        cacheTierEnv === 'extended' ? 'extended' : 'ephemeral';
      // EXTRACTION_MODEL selects the extraction model; UNSET → provider default
      // (so the fully-local Ollama path, one model only, is unaffected).
      const extractionModelId = resolveExtractionModelId();
      const runner = new InlineExtractRunner({
        graphStore: store,
        llmProvider,
        configuration,
        ...(extractionModelId !== undefined ? { modelId: extractionModelId } : {}),
        cacheTier,
      });
      const summary = await runner.run(
        batchForExtraction(paragraphIds).map((batch) => ({
          tenantId: args.tenantId,
          paragraphIds: batch,
        })),
      );
      console.log(
        JSON.stringify(
          {
            configurationId: configuration.id,
            configurationVersion: configuration.version,
            schemaHash,
            jobsMode: 'inline',
            paragraphsProcessed: paragraphIds.length,
            codeParagraphsSkipped: skippedCodeCount,
            ...summary,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Refuse the local-store enqueue rather than strand jobs in a Postgres
    // queue the PGlite store will never see: the worker queue is
    // graphile-worker over DATABASE_URL, which the PGlite store does not run.
    if ((process.env.GRAPH_STORE ?? 'postgres').toLowerCase() === 'local') {
      throw new Error(
        `GRAPH_STORE=local found ${paragraphIds.length} paragraph(s) pending extraction, but JOBS=worker cannot serve a PGlite store (graphile-worker runs over Postgres). Set JOBS=inline to run extraction in-process against the local store.`,
      );
    }

    await withWorkerUtils({ connectionString }, async (utils) => {
      for (const batch of batchForExtraction(paragraphIds)) {
        await enqueueExtractParagraphs(utils, {
          tenantId: args.tenantId,
          paragraphIds: batch,
        });
      }
    });

    console.log(
      JSON.stringify(
        {
          configurationId: configuration.id,
          configurationVersion: configuration.version,
          schemaHash,
          paragraphsEnqueued: paragraphIds.length,
          codeParagraphsSkipped: skippedCodeCount,
          jobsEnqueued: Math.ceil(paragraphIds.length / 5),
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

async function runStatus(args: CliArgs): Promise<void> {
  // Backend-selected store (F44 wiring) — GRAPH_STORE=local opens PGlite; the
  // Postgres path keeps the localhost dev default (same as ingest/query-cli).
  process.env.DATABASE_URL ??= 'postgres://munin:munin@localhost:5432/munin';
  const { store, close } = await loadGraphStore();
  try {
    const configuration = await loadConfiguration();
    const schemaHash = computeSchemaHash(configuration);

    // The actionable staleness signal: paragraphs with no live entity under the
    // current schema (never extracted, or extracted under a superseded schema).
    // Routed through the GraphStore so the CLI holds no raw SQL.
    const pending = await store.findParagraphsPendingExtraction(bypassRead(args.tenantId), {
      schemaHash,
    });

    console.log(
      JSON.stringify(
        {
          tenantId: args.tenantId,
          configuration: `${configuration.id} v${configuration.version}`,
          currentSchemaHash: schemaHash,
          paragraphsPendingExtraction: pending.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

// Runnable core: env is whatever the caller has already loaded into process.env
// (the repo .env for the direct entrypoint below; $MUNIN_HOME/munin.env for the
// `munin extract` wrapper). Does NOT load any .env itself.
export async function runExtractCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  // Local-mode pre-flight (covers both status and extract): refuse up front if
  // the user's AI client is holding the single-process PGlite store, instead of
  // letting the open throw after the fact. No-op for the Postgres path.
  preflightLocalStoreLock();
  if (args.subcommand === 'status') {
    await runStatus(args);
  } else {
    await runExtract(args);
  }
}

// Direct entrypoint (`pnpm --filter munin-mcp extract …`): the repo-root .env is
// authoritative for the dev workflow. When imported as a module (the `munin
// extract` wrapper) this block is skipped, so the home env is not overridden.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv({ path: path.join(repoRoot, '.env'), override: true });
  runExtractCli().catch((err) => {
    // F71: a locked/corrupt local store is an expected hazard of the local flow
    // — friendly line, no raw WASM stack. Other failures print the error.
    if (!reportLocalStoreError(err, { dataDir: process.env.PGLITE_DATA_DIR }))
      console.error('extract failed:', err);
    process.exit(1);
  });
}

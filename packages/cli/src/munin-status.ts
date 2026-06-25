// `munin status` — a deterministic, model-free corpus-health verb (Stage B).
//
// Shows what is in the local memory and how it is wired: the tenant, the loaded
// configuration, document / paragraph / entity / edge counts, paragraphs still
// pending extraction, the store posture (local mode / providers), the MUNIN_HOME
// path, and the most-recent documents. No LLM call — pure reads through the
// FROZEN GraphStore reader under a normal, fail-closed RegularReadContext.
//
// ONE SOURCE OF TRUTH, ACROSS A ONE-WAY DEPENDENCY EDGE. The MCP server's
// `munin_status` tool (packages/mcp/src/tools/status.ts) computes the same corpus
// figures. We cannot literally share one function: the dependency edge is
// one-way (@muninhq/mcp dev-depends on munin-mcp; munin-mcp must NOT import
// @muninhq/mcp — see munin-docs.ts / mcp-doctor.ts), and making the lean read-only
// MCP server runtime-depend on the whole operator CLI would invert that layering.
// So this mirrors the MCP tool's computation the same deliberate way the doctor
// mirrors the MCP tool list and query-defaults is duplicated: the counting shape
// is identical and the two are kept in sync by review. Differences are
// intentional — the CLI uses getGraphStats (entities AND edges in one grouped,
// permission-correct query) where the MCP tool counts entities only, and the CLI
// adds the posture + MUNIN_HOME lines an operator wants. If the corpus-count
// shape changes here, change packages/mcp/src/tools/status.ts too.

import {
  type GraphStoreReader,
  type RegularReadContext,
  asTenantId,
  loadConfigurationWithResolver,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import { type Configuration, computeSchemaHash } from '@muninhq/shared';

import { preflightLocalStoreLock } from './local-store-errors';
import { buildLocalReadContext } from './munin-docs';

// Beyond this many documents the per-document paragraph walk is no longer cheap;
// report null rather than hammering the store (no silent caps). Mirrors the MCP
// tool's constants.
const PARAGRAPH_COUNT_DOC_CAP = 2_000;
const DOC_PAGE_SIZE = 200;
// How many recent document pointers to surface — a useful "what is in here"
// sample, content-free. Not a cap on the corpus.
const RECENT_DOCUMENTS_LIMIT = 10;

/** A content-free recent-document pointer (no paragraph text). */
export interface CorpusStatusDocument {
  readonly documentId: string;
  readonly title: string;
  readonly ingestedAt: Date;
}

/** The corpus figures — the part shared (by mirror) with the MCP munin_status tool. */
export interface CorpusStatus {
  readonly tenantId: string;
  readonly configuration: { readonly id: string; readonly version: string };
  readonly documentCount: number;
  /** Summed per visible document; null when the corpus exceeds the counting cap. */
  readonly paragraphCount: number | null;
  readonly entityCount: number;
  readonly edgeCount: number;
  readonly paragraphsPendingExtraction: number;
  readonly recentDocuments: readonly CorpusStatusDocument[];
}

/**
 * Compute the corpus figures through the frozen reader. Pure over the reader —
 * unit-tested. Mirrors packages/mcp/src/tools/status.ts (see the file header):
 * one document page does double duty (total = document count, items = recent),
 * getGraphStats gives the entity + edge totals in one permission-correct query,
 * and the paragraph total is summed per visible document up to the cap.
 */
export async function computeCorpusStatus(
  reader: GraphStoreReader,
  ctx: RegularReadContext,
  opts: { readonly configuration: Configuration; readonly schemaHash: string },
): Promise<CorpusStatus> {
  const [docPage, stats, pending] = await Promise.all([
    reader.findDocuments(ctx, { limit: RECENT_DOCUMENTS_LIMIT }),
    reader.getGraphStats(ctx),
    reader.findParagraphsPendingExtraction(ctx, { schemaHash: opts.schemaHash }),
  ]);

  let paragraphCount: number | null = null;
  if (docPage.total <= PARAGRAPH_COUNT_DOC_CAP) {
    paragraphCount = 0;
    for (let offset = 0; offset < docPage.total; offset += DOC_PAGE_SIZE) {
      const page = await reader.findDocuments(ctx, { limit: DOC_PAGE_SIZE, offset });
      const counts = await Promise.all(
        page.items.map(async (d) => (await reader.findParagraphsByDocument(ctx, d.id)).length),
      );
      paragraphCount += counts.reduce((a, b) => a + b, 0);
      if (page.items.length < DOC_PAGE_SIZE) break;
    }
  }

  return {
    tenantId: ctx.tenantId,
    configuration: { id: opts.configuration.id, version: opts.configuration.version },
    documentCount: docPage.total,
    paragraphCount,
    entityCount: stats.totalEntities,
    edgeCount: stats.totalEdges,
    paragraphsPendingExtraction: pending.length,
    recentDocuments: docPage.items.map((d) => ({
      documentId: d.id,
      title: d.title,
      ingestedAt: d.createdAt,
    })),
  };
}

/** The env-derived deployment posture for the status header. */
export interface StatusPosture {
  readonly home: string;
  readonly storeBackend: 'local (PGlite)' | 'postgres';
  /** Human-readable posture line (zero-egress / local+cloud / unset). */
  readonly mode: string;
  readonly llmProvider: string;
  readonly embeddingProvider: string;
}

/** Derive the posture from the same env vars the provider factory + doctor read.
 * Pure — unit-tested. Names only (never a key value). */
export function derivePosture(env: NodeJS.ProcessEnv, home: string): StatusPosture {
  const isLocal = (env.GRAPH_STORE ?? '').toLowerCase() === 'local';
  const localMode = env.MUNIN_LOCAL_MODE?.toLowerCase() === 'true';
  const allowCloud = env.MUNIN_ALLOW_CLOUD_PROVIDERS?.toLowerCase() === 'true';
  const mode = localMode
    ? 'fully local — zero egress (MUNIN_LOCAL_MODE=true)'
    : allowCloud
      ? 'local store + cloud AI (MUNIN_ALLOW_CLOUD_PROVIDERS=true)'
      : 'not declared';
  return {
    home,
    storeBackend: isLocal ? 'local (PGlite)' : 'postgres',
    mode,
    llmProvider: env.LLM_PROVIDER ?? '(default)',
    embeddingProvider: env.EMBEDDING_PROVIDER ?? '(default)',
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Render the status as plain text (pure — unit-tested). */
export function formatStatus(status: CorpusStatus, posture: StatusPosture): string {
  const lines: string[] = [];
  lines.push(`Munin memory — ${posture.home} (tenant ${status.tenantId})`);
  lines.push(`  configuration: ${status.configuration.id} v${status.configuration.version}`);
  lines.push(`  store:         ${posture.storeBackend}`);
  lines.push(`  posture:       ${posture.mode}`);
  lines.push(`  providers:     LLM=${posture.llmProvider}  EMBEDDING=${posture.embeddingProvider}`);
  lines.push('');

  if (status.documentCount === 0) {
    lines.push('Corpus is empty. Ingest some with `munin ingest <dir>`, then `munin extract`.');
    return lines.join('\n');
  }

  const paragraphs =
    status.paragraphCount === null
      ? `(not counted — over ${PARAGRAPH_COUNT_DOC_CAP} documents)`
      : String(status.paragraphCount);
  lines.push('Corpus:');
  lines.push(`  documents:           ${status.documentCount}`);
  lines.push(`  paragraphs:          ${paragraphs}`);
  lines.push(`  entities:            ${status.entityCount}`);
  lines.push(`  edges:               ${status.edgeCount}`);
  lines.push(`  pending extraction:  ${status.paragraphsPendingExtraction} paragraph(s)`);
  if (status.paragraphsPendingExtraction > 0) {
    lines.push(
      '    run `munin extract` to build the entity graph (retrieval already works on embeddings).',
    );
  }

  lines.push('');
  lines.push(`Recent documents (newest first, up to ${RECENT_DOCUMENTS_LIMIT}):`);
  for (const d of status.recentDocuments) {
    lines.push(`  • ${d.title}`);
    lines.push(`    ${d.documentId}  ingested ${isoDay(d.ingestedAt)}`);
  }
  return lines.join('\n');
}

export interface RunStatusOptions {
  readonly configPackage: string;
  readonly tenantId: string;
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Open the store via the factory, build the single-user context, and compute the
 * corpus status + posture. Returns both; the CLI renders them with formatStatus.
 */
export async function runStatus(
  opts: RunStatusOptions,
): Promise<{ status: CorpusStatus; posture: StatusPosture }> {
  const env = opts.env ?? process.env;
  // Refuse up front if the user's AI client is holding the single-process PGlite
  // store (no-op for the Postgres path).
  preflightLocalStoreLock(env);
  const tenantId = asTenantId(opts.tenantId);
  const handle = await loadGraphStore(env);
  try {
    const configuration = await loadConfigurationWithResolver(opts.configPackage, (p) => import(p));
    const schemaHash = computeSchemaHash(configuration);
    const ctx = await buildLocalReadContext(configuration, tenantId);
    const status = await computeCorpusStatus(handle.store, ctx, { configuration, schemaHash });
    const posture = derivePosture(env, opts.home);
    return { status, posture };
  } finally {
    await handle.close();
  }
}

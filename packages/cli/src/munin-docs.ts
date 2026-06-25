// `munin docs` core (S2 deliverable 3) — a home-aware, read-only listing of the
// documents in the local memory, so a prosumer can SEE and manage what they have
// ingested from the CLI. The MCP `munin_status` tool surfaces the most-recent
// few; this lists them properly (paginated, newest first) and points at the
// erase path for removal.
//
// Reads go through the FROZEN GraphStore surface under a normal, fail-closed
// RegularReadContext — never raw SQL, never a bypass. The single-user context is
// the union of the configuration's role baseTags, expanded through its
// tagExpansion: the same construction the MCP server uses (context.ts),
// deliberately re-implemented here because munin-mcp must not import @muninhq/mcp
// (that edge is one-way: mcp dev-depends on cli). The actor is pinned to
// `cli:local-user` so the per-read audit attributes the listing honestly.

import {
  type RegularReadContext,
  type TenantId,
  asActorId,
  asTenantId,
  loadConfigurationWithResolver,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import type { Configuration } from '@muninhq/shared';

import { preflightLocalStoreLock } from './local-store-errors';

export const DOCS_ACTOR = 'cli:local-user';
// A sensible page size for an interactive listing — enough to be useful, small
// enough not to flood the terminal. `--limit` overrides it, up to MAX_DOCS_LIMIT.
export const DEFAULT_DOCS_LIMIT = 50;
export const MAX_DOCS_LIMIT = 1000;

/**
 * Parse a `--limit` value strictly: a positive integer with no trailing garbage
 * (so `50abc` is rejected, not silently read as 50), bounded by MAX_DOCS_LIMIT
 * (rejected rather than silently capped — no silent caps). Pure — unit-tested.
 */
export function parseDocsLimit(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`--limit must be a positive integer (got "${raw}")`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (n < 1) throw new Error(`--limit must be at least 1 (got "${raw}")`);
  if (n > MAX_DOCS_LIMIT) {
    throw new Error(`--limit must be at most ${MAX_DOCS_LIMIT} (got ${n})`);
  }
  return n;
}

/** Union of `baseTags` across every role the configuration declares (mirrors
 * the MCP server's single-user context). */
export function singleUserBaseTags(configuration: Configuration): readonly string[] {
  const tags = new Set<string>();
  for (const role of configuration.roles) {
    for (const tag of role.baseTags) tags.add(tag);
  }
  return [...tags];
}

/** Build the single-user RegularReadContext: union of role baseTags, expanded
 * through the configuration's tagExpansion, actor pinned to `cli:local-user`. */
export async function buildLocalReadContext(
  configuration: Configuration,
  tenantId: TenantId,
): Promise<RegularReadContext> {
  const baseTags = singleUserBaseTags(configuration);
  const accessTags = await Promise.resolve(
    configuration.tagExpansion(baseTags, { tenantId, orgUnits: [] }),
  );
  return {
    kind: 'regular',
    tenantId,
    accessTags: [...new Set(accessTags)],
    actor: asActorId(DOCS_ACTOR),
  };
}

/** A content-free document pointer for the listing (no paragraph text). */
export interface DocListItem {
  readonly id: string;
  readonly title: string;
  readonly ingestedAt: Date;
  readonly accessTags: readonly string[];
  readonly superseded: boolean;
}

export interface DocsListView {
  readonly home: string;
  readonly tenantId: string;
  readonly total: number;
  readonly documents: readonly DocListItem[];
}

function isoDate(d: Date): string {
  // Just the calendar day — the full timestamp is noise for a listing.
  return d.toISOString().slice(0, 10);
}

/** Render the listing as plain text (pure — unit-tested). */
export function formatDocsList(view: DocsListView): string {
  const lines: string[] = [];
  lines.push(`Munin memory — ${view.home} (tenant ${view.tenantId})`);

  if (view.total === 0) {
    lines.push('');
    lines.push('No documents yet. Ingest some with `munin ingest <dir>`, then `munin extract`.');
    return lines.join('\n');
  }

  const shown = view.documents.length;
  const suffix = shown < view.total ? `, showing ${shown}` : '';
  lines.push(`${view.total} document${view.total === 1 ? '' : 's'}${suffix}, newest first:`);
  lines.push('');
  for (const d of view.documents) {
    const tags = d.accessTags.length > 0 ? d.accessTags.join(', ') : '(none)';
    const flag = d.superseded ? '  [superseded]' : '';
    lines.push(`  • ${d.title}${flag}`);
    lines.push(`    ${d.id}  ingested ${isoDate(d.ingestedAt)}  tags: ${tags}`);
  }
  lines.push('');
  lines.push('Read one with munin_get_document (MCP) using its id above. To remove a document');
  lines.push('and everything derived from it, run `munin forget <id>` (a dry-run preview by');
  lines.push('default), or use the admin erase page (/admin/erase) in the Munin web app.');
  return lines.join('\n');
}

export interface RunDocsListOptions {
  readonly configPackage: string;
  readonly tenantId: string;
  readonly home: string;
  readonly limit?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Open the store via the factory, build the single-user context, and page the
 * newest documents the caller can see. Returns the view; the CLI renders it.
 */
export async function runDocsList(opts: RunDocsListOptions): Promise<DocsListView> {
  const env = opts.env ?? process.env;
  // Local-mode pre-flight: refuse up front if the user's AI client is holding
  // the single-process PGlite store, before the open throws. No-op otherwise.
  preflightLocalStoreLock(env);
  const limit = opts.limit ?? DEFAULT_DOCS_LIMIT;
  const tenantId = asTenantId(opts.tenantId);
  const handle = await loadGraphStore(env);
  try {
    const configuration = await loadConfigurationWithResolver(opts.configPackage, (p) => import(p));
    const context = await buildLocalReadContext(configuration, tenantId);
    const page = await handle.store.findDocuments(context, { limit });
    return {
      home: opts.home,
      tenantId: opts.tenantId,
      total: page.total,
      documents: page.items.map((d) => ({
        id: d.id,
        title: d.title,
        ingestedAt: d.createdAt,
        accessTags: d.accessTags,
        superseded: d.validTo !== null,
      })),
    };
  } finally {
    await handle.close();
  }
}

// Tenant resolution for the single-user server.
//
// Order: MUNIN_TENANT_ID env var wins; otherwise discover the single
// non-deleted tenant row; if several exist and no env var names one, fail fast
// with a message listing them (never guess — picking the wrong tenant would
// silently scope every read to the wrong corpus).
//
// Discovery note: the GraphStore interface deliberately has no tenant-listing
// reader — tenant rows are control-plane data, not permissioned graph content
// (every GraphStore read REQUIRES a tenantId; this lookup is what produces it).
// We read them through the factory handle's raw Drizzle connection, which
// GraphStoreHandle.db exposes for exactly this kind of control-plane sibling
// read, plus the engine's schema table object. The deleted_at filter runs in
// JS so this package imports no drizzle-orm operators.

import type { TenantId } from '@muninhq/engine';
import { asTenantId } from '@muninhq/engine';
import { tenants } from '@muninhq/engine/db/schema';
import type { GraphStoreHandle } from '@muninhq/engine/graph-store';

interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: Date | null;
}

// Minimal structural view of the Drizzle handle: GraphStoreHandle.db is a
// union of the postgres-js and PGlite database types whose full select-builder
// generics don't unify; the chained select().from() call shape is identical.
interface TenantSelect {
  select(fields: {
    id: typeof tenants.id;
    name: typeof tenants.name;
    deletedAt: typeof tenants.deletedAt;
  }): { from(table: typeof tenants): Promise<TenantRow[]> };
}

export interface ResolvedTenant {
  readonly tenantId: TenantId;
  readonly source: 'env' | 'discovered';
}

export async function resolveTenant(
  handle: Pick<GraphStoreHandle, 'db'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTenant> {
  const fromEnv = env.MUNIN_TENANT_ID?.trim();
  if (fromEnv) return { tenantId: asTenantId(fromEnv), source: 'env' };

  const db = handle.db as unknown as TenantSelect;
  const rows = await db
    .select({ id: tenants.id, name: tenants.name, deletedAt: tenants.deletedAt })
    .from(tenants);
  const live = rows.filter((r) => r.deletedAt === null);

  if (live.length === 1 && live[0]) {
    return { tenantId: asTenantId(live[0].id), source: 'discovered' };
  }
  if (live.length === 0) {
    throw new Error(
      'No tenant found in the database. Seed one first (e.g. `pnpm --filter munin-mcp demo:seed --pack <name>` or `tenancy:seed`), or set MUNIN_TENANT_ID.',
    );
  }
  const listing = live.map((t) => `  ${t.id}  (${t.name})`).join('\n');
  throw new Error(`Multiple tenants exist — set MUNIN_TENANT_ID to choose one:\n${listing}`);
}

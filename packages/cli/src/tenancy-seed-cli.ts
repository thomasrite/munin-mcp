// `pnpm --filter munin-mcp tenancy:seed` — seed the D3 operational metadata
// for local dev so the web app's getRequestContext() can resolve a session to a
// ReadContext.
//
//   tenancy:seed --tenant <uuid> --entra-tid <tid>
//
// Idempotent. Generic: it reads the loaded configuration's roles and creates
// one `app_role` binding per role whose subject value EQUALS the role name —
// the dev convention so a dev user with roles:["admin"] resolves to the config
// "admin" role. Real Entra deployments bind actual app-role values/OIDs via the
// admin UI (later); this is a dev convenience, not vertical logic.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigurationWithResolver } from '@muninhq/engine';
import { groupRoleBindings, tenantDirectory, tenants } from '@muninhq/engine/db/schema';
import { config as loadEnv } from 'dotenv';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
loadEnv({ path: path.join(repoRoot, '.env'), override: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const entraTenantId = arg('entra-tid');
  if (!tenantId || !entraTenantId) {
    throw new Error('usage: tenancy:seed --tenant <uuid> --entra-tid <tid>');
  }
  const pkg = process.env.EXTRACTION_CONFIG_PACKAGE;
  if (!pkg?.trim()) {
    throw new Error('EXTRACTION_CONFIG_PACKAGE is required (e.g. @muninhq/config-generic-demo).');
  }
  const url = process.env.DATABASE_URL ?? 'postgres://munin:munin@localhost:5432/munin';

  // Resolve in this CLI's module context (F20).
  const configuration = await loadConfigurationWithResolver(pkg, (p) => import(p));
  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);

    // Tenant row.
    const existingTenant = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
      .limit(1);
    if (existingTenant.length === 0) {
      await db.insert(tenants).values({ id: tenantId, name: `dev:${pkg}` });
    }

    // Control-plane directory mapping.
    const existingDir = await db
      .select()
      .from(tenantDirectory)
      .where(
        and(eq(tenantDirectory.entraTenantId, entraTenantId), isNull(tenantDirectory.deletedAt)),
      )
      .limit(1);
    if (existingDir.length === 0) {
      await db.insert(tenantDirectory).values({ entraTenantId, tenantId });
    }

    // One app_role binding per configuration role (subject value == role name).
    let created = 0;
    for (const role of configuration.roles) {
      const existing = await db
        .select()
        .from(groupRoleBindings)
        .where(
          and(
            eq(groupRoleBindings.tenantId, tenantId),
            eq(groupRoleBindings.subjectKind, 'app_role'),
            eq(groupRoleBindings.subjectId, role.name),
            eq(groupRoleBindings.roleName, role.name),
            isNull(groupRoleBindings.deletedAt),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        await db.insert(groupRoleBindings).values({
          tenantId,
          subjectKind: 'app_role',
          subjectId: role.name,
          roleName: role.name,
        });
        created += 1;
      }
    }

    console.log(
      `seeded tenant ${tenantId} (entra-tid ${entraTenantId}) for ${pkg}: ${configuration.roles.length} roles, ${created} new bindings`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('tenancy:seed failed:', err);
  process.exit(1);
});

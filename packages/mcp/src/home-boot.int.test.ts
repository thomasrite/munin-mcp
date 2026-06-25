// PORTABILITY REGRESSION (F68/S1): the launcher boots from a MUNIN_HOME with
// NO repo .env in play. Proves the substantive claim end-to-end against a real
// PGlite store (no Docker): a home's munin.env + derived data dirs is a
// complete, repo-independent boot config.
//
// We seed a tenant into $home/pgdata, write a $home/munin.env (stub providers,
// no data-dir lines), then drive the ACTUAL launcher path —
// loadMuninHomeEnv() → bootstrapRuntime() — through process.env, asserting it
// resolves the home's config and never reaches for a repo root. process.env is
// snapshotted and restored so the global dotenv load does not leak.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { asTenantId } from '@muninhq/engine';
import { tenants } from '@muninhq/engine/db/schema';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import { muninHomeLayout } from '@muninhq/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMuninHomeEnv } from './home-env';
import { type McpRuntime, bootstrapRuntime } from './runtime';

const TENANT_ID = '00000000-0000-4000-8000-0000000b0001';

// Minimal structural view of the factory handle's Drizzle connection — the
// sanctioned control-plane insert pattern (tenant rows have no GraphStore
// writer; same as local-init.ts / the demo seeder).
interface ControlPlaneDb {
  insert(table: typeof tenants): { values(row: { id: string; name: string }): Promise<unknown> };
}

async function seedTenant(pgliteDataDir: string): Promise<void> {
  const handle = await loadGraphStore({
    GRAPH_STORE: 'local',
    PGLITE_DATA_DIR: pgliteDataDir,
  } as NodeJS.ProcessEnv);
  try {
    const db = handle.db as unknown as ControlPlaneDb;
    await db.insert(tenants).values({ id: TENANT_ID, name: 'local' });
  } finally {
    await handle.close();
  }
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(before: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in before)) Reflect.deleteProperty(process.env, key);
  }
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe('launcher boot from MUNIN_HOME (no repo .env)', () => {
  let home: string;
  let envBefore: NodeJS.ProcessEnv;
  let runtime: McpRuntime | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-home-boot-'));
    envBefore = snapshotEnv();
  });

  afterEach(async () => {
    if (runtime) await runtime.close();
    runtime = undefined;
    restoreEnv(envBefore);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loads munin.env + derives data dirs and boots a working runtime', async () => {
    const layout = muninHomeLayout(home);
    fs.mkdirSync(layout.pgliteDataDir, { recursive: true });
    await seedTenant(layout.pgliteDataDir);

    // A home-mode munin.env: NO PGLITE_DATA_DIR / BLOB_STORAGE_FS_ROOT lines —
    // those are derived from the home by the launcher.
    fs.writeFileSync(
      layout.envPath,
      [
        'GRAPH_STORE=local',
        'JOBS=inline',
        'MUNIN_LOCAL_MODE=true',
        'LLM_PROVIDER=stub',
        'EMBEDDING_PROVIDER=stub',
        'MUNIN_CONFIG_PACKAGE=@muninhq/config-personal',
        'EXTRACTION_CONFIG_PACKAGE=@muninhq/config-personal',
        `MUNIN_TENANT_ID=${TENANT_ID}`,
        '',
      ].join('\n'),
    );

    // Simulate a fresh launcher process: only MUNIN_HOME is known; strip the
    // keys the home file is responsible for so we prove they come FROM the home.
    for (const key of [
      'GRAPH_STORE',
      'PGLITE_DATA_DIR',
      'BLOB_STORAGE_FS_ROOT',
      'MUNIN_CONFIG_PACKAGE',
      'EXTRACTION_CONFIG_PACKAGE',
      'MUNIN_TENANT_ID',
      'LLM_PROVIDER',
      'EMBEDDING_PROVIDER',
      'DATABASE_URL',
    ]) {
      Reflect.deleteProperty(process.env, key);
    }
    process.env.MUNIN_HOME = home;

    const loaded = loadMuninHomeEnv();
    expect(loaded.envLoaded).toBe(true);
    expect(process.env.PGLITE_DATA_DIR).toBe(layout.pgliteDataDir);
    expect(process.env.MUNIN_CONFIG_PACKAGE).toBe('@muninhq/config-personal');

    runtime = await bootstrapRuntime();
    expect(runtime.tenantId).toBe(asTenantId(TENANT_ID));
    expect(runtime.tenantSource).toBe('env');
    expect(runtime.configuration.id).toBeTruthy();
    expect(runtime.context.accessTags.length).toBeGreaterThan(0);
  });
});

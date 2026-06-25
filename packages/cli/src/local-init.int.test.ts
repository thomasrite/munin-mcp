// Integration tests for local:init — real PGlite in a temp dir (no Docker).
//
// Proves the spec end-to-end: fresh run writes a complete .env, provisions
// the tenant through the factory path, and creates the data dirs; a re-run is
// idempotent (same tenant, same key, no duplicates, no file edit); a
// pre-existing unrelated .env is refused untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tenants } from '@muninhq/engine/db/schema';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import { isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalInitRefusalError, parseEnvFile, runLocalInit } from './local-init';

// The base env passed to runLocalInit — deliberately NOT process.env, so the
// repo-root .env (loaded by test-setup with override:true) cannot leak
// GRAPH_STORE/PGLITE_DATA_DIR into the factory call.
const BASE_ENV = {} as NodeJS.ProcessEnv;

interface TenantRow {
  readonly id: string;
  readonly name: string;
}

async function readLiveTenants(pgliteDataDir: string): Promise<TenantRow[]> {
  const handle = await loadGraphStore({
    ...BASE_ENV,
    GRAPH_STORE: 'local',
    PGLITE_DATA_DIR: pgliteDataDir,
  });
  try {
    interface TenantSelect {
      select(fields: { id: typeof tenants.id; name: typeof tenants.name }): {
        from(table: typeof tenants): { where(condition: unknown): Promise<TenantRow[]> };
      };
    }
    const db = handle.db as unknown as TenantSelect;
    return await db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(isNull(tenants.deletedAt));
  } finally {
    await handle.close();
  }
}

describe('local:init (PGlite, temp dir)', () => {
  let tmp: string;
  let directory: string;
  let envPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-local-init-'));
    directory = path.join(tmp, '.munin-local');
    envPath = path.join(tmp, '.env');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fresh run: writes a complete .env, creates dirs, provisions a readable tenant', async () => {
    const result = await runLocalInit({ directory, envPath, baseEnv: BASE_ENV });

    expect(result.wroteEnv).toBe(true);
    expect(result.tenantCreated).toBe(true);
    expect(fs.existsSync(path.join(directory, 'pgdata'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'blobs'))).toBe(true);

    const vars = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    for (const key of [
      'GRAPH_STORE',
      'PGLITE_DATA_DIR',
      'JOBS',
      'MUNIN_LOCAL_MODE',
      'LLM_PROVIDER',
      'EMBEDDING_PROVIDER',
      'OLLAMA_MODEL',
      'ANSWER_MODEL',
      'OLLAMA_EMBEDDING_MODEL',
      'BLOB_STORAGE_IMPL',
      'BLOB_STORAGE_FS_ROOT',
      'MUNIN_BLOB_ENCRYPTION_KEY',
      'EXTRACTION_CONFIG_PACKAGE',
      'MUNIN_CONFIG_PACKAGE',
      'MUNIN_TENANT_ID',
    ]) {
      expect(vars.get(key), key).toBeTruthy();
    }
    expect(vars.get('MUNIN_TENANT_ID')).toBe(result.tenantId);
    const key = vars.get('MUNIN_BLOB_ENCRYPTION_KEY');
    expect(Buffer.from(key ?? '', 'base64')).toHaveLength(32);

    // Tenant row readable back through the factory handle.
    const live = await readLiveTenants(result.pgliteDataDir);
    expect(live).toEqual([{ id: result.tenantId, name: 'local' }]);
  }, 120_000);

  it('re-run: same tenant id, same key, file untouched, no duplicates', async () => {
    const first = await runLocalInit({ directory, envPath, baseEnv: BASE_ENV });
    const envAfterFirst = fs.readFileSync(envPath, 'utf8');

    const second = await runLocalInit({ directory, envPath, baseEnv: BASE_ENV });
    expect(second.wroteEnv).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.tenantCreated).toBe(false);

    // Byte-for-byte: the .env (key included) is never rewritten.
    expect(fs.readFileSync(envPath, 'utf8')).toBe(envAfterFirst);

    const live = await readLiveTenants(second.pgliteDataDir);
    expect(live).toHaveLength(1);
  }, 120_000);

  it('pre-existing unrelated .env: refused with a report, file untouched, no store created', async () => {
    const original = '# my settings\nDATABASE_URL=postgres://munin:munin@localhost:5432/munin\n';
    fs.writeFileSync(envPath, original);

    await expect(runLocalInit({ directory, envPath, baseEnv: BASE_ENV })).rejects.toThrowError(
      LocalInitRefusalError,
    );
    try {
      await runLocalInit({ directory, envPath, baseEnv: BASE_ENV });
    } catch (err) {
      const lines = (err as LocalInitRefusalError).reportLines.join('\n');
      expect(lines).toContain('never edits an existing .env');
      expect(lines).toContain('+ GRAPH_STORE=local');
    }
    expect(fs.readFileSync(envPath, 'utf8')).toBe(original);
  }, 120_000);

  it('re-materialises the tenant under the same id when the data dir was wiped', async () => {
    const first = await runLocalInit({ directory, envPath, baseEnv: BASE_ENV });
    fs.rmSync(path.join(directory, 'pgdata'), { recursive: true, force: true });

    const second = await runLocalInit({ directory, envPath, baseEnv: BASE_ENV });
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.tenantCreated).toBe(true);
    expect(second.wroteEnv).toBe(false);

    const live = await readLiveTenants(second.pgliteDataDir);
    expect(live).toEqual([{ id: first.tenantId, name: 'local' }]);
  }, 120_000);
});

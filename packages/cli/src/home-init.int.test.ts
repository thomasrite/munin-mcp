// Integration tests for `munin init` (runHomeInit) — real PGlite in a temp home
// (no Docker). Proves: a fresh run writes a complete munin.env at mode 0600 with
// NO baked-in data paths (derived from MUNIN_HOME), provisions the tenant, and
// creates the data dirs; a re-run is idempotent (same tenant, file untouched).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { muninHomeLayout } from '@muninhq/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHomeInit } from './home-init';
import { assessHomeEnv } from './home-init';
import { parseEnvFile } from './local-init';

// Not process.env — so the repo .env (loaded with override by test-setup) cannot
// leak GRAPH_STORE/PGLITE_DATA_DIR into the factory call.
const BASE_ENV = {} as NodeJS.ProcessEnv;

describe('munin init (home mode, PGlite, temp dir)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-home-init-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('fresh run: writes munin.env (0600, no data paths), creates dirs, provisions a tenant', async () => {
    const result = await runHomeInit({ home, baseEnv: BASE_ENV });
    const layout = muninHomeLayout(home);

    expect(result.wroteEnv).toBe(true);
    expect(result.tenantCreated).toBe(true);
    expect(result.envPath).toBe(layout.envPath);
    expect(fs.existsSync(layout.pgliteDataDir)).toBe(true);
    expect(fs.existsSync(layout.blobFsRoot)).toBe(true);

    // Mode 0600 — the file holds the AES blob key.
    expect(fs.statSync(layout.envPath).mode & 0o777).toBe(0o600);

    const vars = parseEnvFile(fs.readFileSync(layout.envPath, 'utf8'));
    // Portable settings present...
    for (const key of [
      'GRAPH_STORE',
      'JOBS',
      'MUNIN_LOCAL_MODE',
      'LLM_PROVIDER',
      'EMBEDDING_PROVIDER',
      'MUNIN_BLOB_ENCRYPTION_KEY',
      'EXTRACTION_CONFIG_PACKAGE',
      'MUNIN_CONFIG_PACKAGE',
      'MUNIN_TENANT_ID',
    ]) {
      expect(vars.has(key)).toBe(true);
    }
    // ...but NOT the absolute data-dir lines (derived from the home).
    expect(vars.has('PGLITE_DATA_DIR')).toBe(false);
    expect(vars.has('BLOB_STORAGE_FS_ROOT')).toBe(false);
    expect(vars.get('MUNIN_TENANT_ID')).toBe(result.tenantId);
  });

  it('re-run is idempotent: same tenant, file untouched, accepted by the home assessment', async () => {
    const first = await runHomeInit({ home, baseEnv: BASE_ENV });
    const layout = muninHomeLayout(home);
    const before = fs.readFileSync(layout.envPath, 'utf8');

    const second = await runHomeInit({ home, baseEnv: BASE_ENV });
    expect(second.wroteEnv).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.tenantCreated).toBe(false);
    expect(fs.readFileSync(layout.envPath, 'utf8')).toBe(before);

    // The written munin.env satisfies the home-aware assessment (no data paths required).
    expect(assessHomeEnv(before, layout).ok).toBe(true);
  });

  it('re-materialises the tenant under the same id when the store was wiped', async () => {
    const first = await runHomeInit({ home, baseEnv: BASE_ENV });
    const layout = muninHomeLayout(home);
    // Simulate a deleted data dir (munin.env still names the tenant).
    fs.rmSync(layout.pgliteDataDir, { recursive: true, force: true });

    const second = await runHomeInit({ home, baseEnv: BASE_ENV });
    expect(second.wroteEnv).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.tenantCreated).toBe(true);
  });
});

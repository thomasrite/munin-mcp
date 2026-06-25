// Unit tests for the launcher's config source (home-env.ts). The portability
// guarantee in one assertion: given a MUNIN_HOME, the launcher loads
// $home/munin.env and derives its data dirs — it never reaches for a repo .env.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { muninHomeLayout } from '@muninhq/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasUsableConfig, loadMuninHomeEnv } from './home-env';

describe('loadMuninHomeEnv', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-home-env-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('derives data dirs from the home when unset (no munin.env present)', () => {
    const env = { MUNIN_HOME: home } as NodeJS.ProcessEnv;
    const loaded = loadMuninHomeEnv(env);

    const layout = muninHomeLayout(home);
    expect(loaded.envLoaded).toBe(false);
    expect(loaded.layout.home).toBe(layout.home);
    expect(env.PGLITE_DATA_DIR).toBe(layout.pgliteDataDir);
    expect(env.BLOB_STORAGE_FS_ROOT).toBe(layout.blobFsRoot);
  });

  it('reports envLoaded=true and derives data dirs when munin.env exists', () => {
    const layout = muninHomeLayout(home);
    fs.writeFileSync(layout.envPath, 'MUNIN_CONFIG_PACKAGE=@muninhq/config-personal\n');

    // A fresh env object so the (process.env-bound) dotenv load is not asserted
    // here — only the return flag + derived dirs, which land on the passed env.
    const env = { MUNIN_HOME: home } as NodeJS.ProcessEnv;
    const loaded = loadMuninHomeEnv(env);

    expect(loaded.envLoaded).toBe(true);
    expect(env.PGLITE_DATA_DIR).toBe(layout.pgliteDataDir);
    expect(env.BLOB_STORAGE_FS_ROOT).toBe(layout.blobFsRoot);

    // Cleanup: dotenv writes into process.env regardless of the passed env.
    Reflect.deleteProperty(process.env, 'MUNIN_CONFIG_PACKAGE');
  });

  it('does not depend on a repo .env (no repo-root derivation)', () => {
    // The launcher source must never compute a repo root or load <repo>/.env.
    const src = fs.readFileSync(path.join(__dirname, 'home-env.ts'), 'utf8');
    expect(src).not.toMatch(/\/\.\.\/\.\.\/\.\./); // the old `resolve(here, '../../..')`
    expect(src.includes("'../../..'")).toBe(false);
  });

  it('keeps an explicit data dir (escape hatch wins over the derived value)', () => {
    const env = {
      MUNIN_HOME: home,
      PGLITE_DATA_DIR: '/custom/pgdata',
    } as NodeJS.ProcessEnv;
    loadMuninHomeEnv(env);
    expect(env.PGLITE_DATA_DIR).toBe('/custom/pgdata');
  });
});

describe('hasUsableConfig', () => {
  const layout = muninHomeLayout('/tmp/x');

  it('true when munin.env loaded', () => {
    expect(hasUsableConfig({ layout, envLoaded: true }, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('true when MUNIN_CONFIG_PACKAGE supplied another way', () => {
    expect(
      hasUsableConfig({ layout, envLoaded: false }, {
        MUNIN_CONFIG_PACKAGE: '@muninhq/config-personal',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('false when neither a home nor an ambient config exists', () => {
    expect(hasUsableConfig({ layout, envLoaded: false }, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

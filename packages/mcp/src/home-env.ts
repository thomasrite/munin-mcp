// Launcher config source: MUNIN_HOME, not the repo (F68 / S1).
//
// The old launcher derived a repo root and loaded <repo>/.env — which is a
// silent no-op outside the checkout, forcing every setting into the client's
// mcpServers JSON `env` block. Instead the launcher reads its config from a
// per-user home ($MUNIN_HOME, default ~/.munin): one `munin.env` file plus
// derived data directories. This makes the configuration checkout-independent
// and relocatable.
//
// `munin.env` is authoritative BY DESIGN: it is loaded with override:true so a
// stray ambient value (from the client's env block or the shell) cannot flip
// MUNIN_LOCAL_MODE or the tenant. The data directories (pgdata/, blobs/) are
// DERIVED from the home and injected only when unset, so an explicit
// PGLITE_DATA_DIR / BLOB_STORAGE_FS_ROOT still wins (escape hatch) while the
// common case carries none — moving the home moves the data with it.

import fs from 'node:fs';

import { type MuninHomeLayout, muninHomeLayout, resolveMuninHome } from '@muninhq/shared';
import { config as loadEnv } from 'dotenv';

export interface LoadedHomeEnv {
  /** The resolved home layout (home + envPath + derived data dirs). */
  readonly layout: MuninHomeLayout;
  /** Whether a munin.env file was found and loaded. */
  readonly envLoaded: boolean;
}

/**
 * Resolve the home, load its munin.env (if present), and inject the derived
 * data directories into `env`. Mutates `env` in place (defaults to process.env,
 * which is what the factories read). Returns the layout and whether a settings
 * file was loaded.
 *
 * dotenv writes into process.env; when `env` is process.env (the launcher case)
 * the loaded values and the derived data dirs land in the same place the engine
 * factories read from. The function never touches a repo root.
 */
export function loadMuninHomeEnv(env: NodeJS.ProcessEnv = process.env): LoadedHomeEnv {
  const layout = muninHomeLayout(resolveMuninHome(env));

  const envLoaded = fs.existsSync(layout.envPath);
  if (envLoaded) {
    // Authoritative: the home file overrides ambient/client-supplied values.
    loadEnv({ path: layout.envPath, override: true });
  }

  // Derive data dirs from the home, but only when unset — an explicit value
  // (in munin.env or the ambient env) is an intentional escape hatch and wins.
  if (!env.PGLITE_DATA_DIR?.trim()) env.PGLITE_DATA_DIR = layout.pgliteDataDir;
  if (!env.BLOB_STORAGE_FS_ROOT?.trim()) env.BLOB_STORAGE_FS_ROOT = layout.blobFsRoot;

  return { layout, envLoaded };
}

/**
 * Decide whether the launcher has a usable configuration. A home is usable if
 * its munin.env loaded, or the caller supplied MUNIN_CONFIG_PACKAGE another way
 * (e.g. an advanced client env block). Used to fail fast with a friendly
 * "run `munin init`" message instead of crashing deep in bootstrap.
 */
export function hasUsableConfig(
  loaded: LoadedHomeEnv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return loaded.envLoaded || Boolean(env.MUNIN_CONFIG_PACKAGE?.trim());
}

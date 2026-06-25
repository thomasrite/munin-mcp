// MUNIN_HOME — the one relocatable per-user directory (F68 / S1).
//
// A single directory holds everything a local Munin install needs, so it is the
// unit you move/point-at:
//
//   $MUNIN_HOME/            (default ~/.munin)
//     munin.env             # the ONE settings file (KEY=VALUE), mode 0600
//     pgdata/               # PGlite data        → PGLITE_DATA_DIR
//     blobs/                # encrypted blobs    → BLOB_STORAGE_FS_ROOT
//
// This module is PURE path plumbing: it computes where those things live; it
// neither reads nor writes them. The data directories are DERIVED from the home
// (never baked into munin.env) so the whole directory relocates cleanly — a
// `munin.env` with an absolute PGLITE_DATA_DIR would break the instant the home
// moves to a new path. Launcher, init, doctor, and the ingest/extract wrappers
// all share these helpers so the layout is computed in exactly one place.
//
// Lives in @muninhq/shared (engine-tier but NOT packages/engine): both @muninhq/mcp
// and munin-mcp already depend on shared, so this adds no new dependency edge,
// and a path helper carries no vertical concept. Uses only Node built-ins —
// @muninhq/shared already imports node:fs/node:path/node:crypto elsewhere
// (demo-pack-loader, config-compose), so this introduces nothing new to the
// module graph.

import os from 'node:os';
import path from 'node:path';

/** The default home when MUNIN_HOME is unset: ~/.munin. */
export const DEFAULT_MUNIN_HOME_DIRNAME = '.munin';

/** The settings filename inside a home — deliberately NOT `.env`, to avoid any
 * confusion with the repo-root `.env`. */
export const MUNIN_ENV_FILENAME = 'munin.env';

export interface MuninHomeLayout {
  /** The absolute home directory. */
  readonly home: string;
  /** Absolute path of the one settings file ($home/munin.env). */
  readonly envPath: string;
  /** Absolute PGlite data directory ($home/pgdata) → PGLITE_DATA_DIR. */
  readonly pgliteDataDir: string;
  /** Absolute encrypted-blob root ($home/blobs) → BLOB_STORAGE_FS_ROOT. */
  readonly blobFsRoot: string;
}

/**
 * Resolve the Munin home directory to an absolute path.
 *
 * `MUNIN_HOME` wins when set (a relative value is resolved against the current
 * working directory so it is always absolute downstream); otherwise the default
 * is `~/.munin`. An explicit empty/whitespace MUNIN_HOME is treated as unset.
 */
export function resolveMuninHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MUNIN_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), DEFAULT_MUNIN_HOME_DIRNAME);
}

/**
 * Compute the file/directory layout for a home directory. Pure: derives paths
 * only, touches nothing on disk. `home` may be relative; it is resolved to an
 * absolute path so every derived path is absolute too.
 */
export function muninHomeLayout(home: string): MuninHomeLayout {
  const abs = path.resolve(home);
  return {
    home: abs,
    envPath: path.join(abs, MUNIN_ENV_FILENAME),
    pgliteDataDir: path.join(abs, 'pgdata'),
    blobFsRoot: path.join(abs, 'blobs'),
  };
}

/** Convenience: resolve the home from env and compute its layout in one call. */
export function resolveMuninHomeLayout(env: NodeJS.ProcessEnv = process.env): MuninHomeLayout {
  return muninHomeLayout(resolveMuninHome(env));
}

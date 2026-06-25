// Friendly CLI handling for the two local-store failure modes (F71).
//
// The engine surfaces a typed LocalStoreLockedError (another live process holds
// the local PGlite store) and LocalStoreUnavailableError (the store is locked-or-
// corrupt and could not be opened). For the prosumer local flow these are the
// EXPECTED hazards — "I dropped files in while my AI client was connected" — so
// we print a clear, product-framed line and NO raw WASM stack. Returns true when
// it handled the error (the caller should exit non-zero), false otherwise.

import path from 'node:path';

import {
  LocalStoreLockedError,
  LocalStoreUnavailableError,
  inspectLock,
} from '@muninhq/engine/graph-store';

// The one message for "the store is held by a live process". Both the up-front
// pre-flight refusal and the post-open LocalStoreLockedError report print it, so
// the guidance is identical whichever path surfaces the contention.
const LOCKED_MESSAGE =
  'munin: your local memory is in use by another process (most likely your AI client).\n' +
  'Quit Claude Desktop (or Cursor), and stop any running `munin ingest`/`extract`, then try again.';

export interface LocalStoreErrorContext {
  /** The local PGlite data dir (typically process.env.PGLITE_DATA_DIR) — used to
   * re-probe the lock and to derive the home for the rebuild guidance. */
  readonly dataDir?: string | undefined;
}

/** Double-quote a path so a home with spaces is a single shell argument. */
function shellQuote(p: string): string {
  return `"${p}"`;
}

/**
 * The one-command rebuild for a corrupt local store, naming the home if it can
 * be derived from the data dir (pgdata lives directly under the home), else the
 * `$MUNIN_HOME` env var. Shared with `munin mcp doctor` so its corrupt-branch
 * remedy stays consistent with the CLI's.
 */
export function rebuildCommand(dataDir?: string): string {
  const home = dataDir?.trim() ? path.dirname(dataDir.trim()) : undefined;
  return `rm -rf ${home ? shellQuote(home) : '"$MUNIN_HOME"'} && munin init`;
}

// RECOVERY FINDING (why we rebuild from source, not from the blobs).
// The home keeps the raw document bytes as encrypted blobs under
// $MUNIN_HOME/blobs (decryptable with MUNIN_BLOB_ENCRYPTION_KEY from munin.env),
// so it is tempting to auto-recover a corrupt pgdata by re-ingesting them. We
// deliberately do NOT: the blob is keyed `documents/<uuid>/<title>` and is JUST
// the bytes — every piece of metadata that makes a blob a MEMORY (its access
// tags, its source path / externalId, version lineage, sensitivity class, the
// paragraph/chunk structure, embeddings and extracted entities) lives ONLY in
// the Postgres store that just corrupted. Re-ingesting the blobs would silently
// drop the tags (everything would inherit a default grant), lose the source
// path (breaking versioning and provenance), and re-run extraction from
// scratch — a strictly WORSE result than re-ingesting the user's ORIGINAL files,
// which are still on disk and ARE the authoritative source. So the honest
// recovery is the guided rebuild below (`rm -rf <home> && munin init`, then
// re-ingest from the source folder), not blob replay. Prevention (removing the
// per-read write from the read path) is the real fix; this is the last resort.

/** The guided-rebuild block for a dirty/corrupt local store with no live holder. */
function formatDirtyStoreGuidance(err: LocalStoreUnavailableError, dataDir?: string): string {
  return [
    `munin: ${err.message}`,
    '',
    'No AI client is holding the store, so the on-disk database is corrupt — most',
    'often a process killed mid-write (there is no automatic repair). Rebuild it:',
    '',
    `  ${rebuildCommand(dataDir)}`,
    '',
    'then re-add your cloud key (if you used one) and re-ingest:',
    '  munin set-key openai|anthropic    (only if you were using a cloud provider)',
    '  munin ingest /path/to/your/docs',
    '  munin extract',
  ].join('\n');
}

export function reportLocalStoreError(err: unknown, ctx: LocalStoreErrorContext = {}): boolean {
  if (err instanceof LocalStoreLockedError) {
    console.error(LOCKED_MESSAGE);
    return true;
  }
  if (err instanceof LocalStoreUnavailableError) {
    const dataDir = ctx.dataDir?.trim();
    // A LIVE holder appearing here means the "unavailable" open was really a
    // contention race — give the in-use guidance, not "your store is corrupt".
    if (dataDir && inspectLock(dataDir) !== null) {
      console.error(LOCKED_MESSAGE);
      return true;
    }
    // No live holder: the store is genuinely corrupt — guide the rebuild.
    console.error(formatDirtyStoreGuidance(err, dataDir));
    return true;
  }
  return false;
}

/**
 * Local-mode pre-flight: if a LIVE process already holds the single-process
 * PGlite store (the user's AI client), refuse UP FRONT — throwing the same
 * LocalStoreLockedError the open would, so reportLocalStoreError prints the
 * identical friendly line — BEFORE the scary WASM open is attempted. No-op for
 * the Postgres path, an in-memory store, or when no live holder is present
 * (inspectLock never opens PGlite, so it cannot corrupt a held data dir).
 */
export function preflightLocalStoreLock(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.GRAPH_STORE ?? '').toLowerCase() !== 'local') return;
  const dataDir = env.PGLITE_DATA_DIR?.trim();
  if (!dataDir) return;
  if (inspectLock(dataDir) !== null) {
    throw new LocalStoreLockedError(`${dataDir}.lock`, undefined);
  }
}

// Advisory inter-process lock for the local PGlite data dir (F71).
//
// PGlite is single-process / single-connection (real Postgres compiled to WASM,
// running in-process). Nothing in PGlite stops two OS processes from opening the
// SAME on-disk pgdata at once — and when they do, the second open corrupts/locks
// the store and surfaces as a raw WASM `RuntimeError: Aborted()`. The lead local
// workflow trips this: a user runs `munin ingest` while their AI client's MCP
// server is already holding the store.
//
// This module is the guard: an atomic exclusive lockfile at `${dataDir}.lock`
// (a sibling of the pgdata dir), created with `fs.open(..., 'wx')` so creation
// fails if it already exists — the OS gives us the mutual exclusion for free, no
// dependency. It is ADVISORY (it does not stop a process that ignores it), but
// every Munin entrypoint into the local store goes through here, so in practice
// it serialises them.
//
// Engine-tier and VERTICAL-AGNOSTIC: messages talk about "the local database"
// and "another Munin process", never a vertical concept. It is LOCAL-MODE ONLY —
// the hosted Postgres path manages its own concurrency and never calls this.

import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';

// Recorded in the lockfile so a refusal can name the holder and a stale-lock
// reclaim can probe liveness. Content-free beyond process identity.
export interface LockfileContents {
  readonly pid: number;
  readonly startedAt: string;
  readonly hostname: string;
}

// Thrown when the lock is held by a LIVE process: refuse rather than open the
// store concurrently. Carries the holder's identity so the CLI/MCP can tell the
// user which process to stop.
export class LocalStoreLockedError extends Error {
  constructor(
    public readonly lockfilePath: string,
    public readonly holder: LockfileContents | undefined,
  ) {
    const who =
      holder !== undefined
        ? `pid ${holder.pid} on ${holder.hostname} since ${holder.startedAt}`
        : 'another process';
    super(
      `the local database is already in use by ${who}. Only one Munin process can use a local store at a time — stop the other process and try again.`,
    );
    this.name = 'LocalStoreLockedError';
  }
}

// A handle to a held lock. `release()` is idempotent and best-effort: it removes
// the lockfile only if WE still own it (matched by pid), and never throws.
export interface PgliteLockHandle {
  readonly lockfilePath: string;
  readonly release: () => Promise<void>;
}

// `dataDir` values that name an in-memory PGlite database, not a filesystem path:
// there is no file to lock and no cross-process concern, so acquireLocalStoreLock
// returns a no-op handle for these. `memory://` is PGlite's explicit in-memory
// prefix; an empty/whitespace value is treated as in-memory too. (`idb://` is the
// browser IndexedDB backend, never used by the Node local runtime, but excluded
// for completeness.)
function isInMemoryDataDir(dataDir: string): boolean {
  const d = dataDir.trim();
  if (d.length === 0) return true;
  return d.startsWith('memory://') || d.startsWith('idb://');
}

// Is `pid` a live process on THIS host? `process.kill(pid, 0)` sends no signal;
// it just probes existence/permissions. ESRCH → no such process (stale). EPERM →
// the process exists but is owned by another user — still alive, so NOT stale.
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM (or anything else) → assume alive; do not reclaim a lock we cannot
    // prove is dead.
    return true;
  }
}

function parseLockfile(raw: string): LockfileContents | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockfileContents>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.hostname === 'string'
    ) {
      return { pid: parsed.pid, startedAt: parsed.startedAt, hostname: parsed.hostname };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Try to create the lockfile exclusively. Returns 'created' on success (our
// identity written), or 'exists' if the lockfile is already present (caller
// decides whether to reclaim).
async function tryCreateLock(
  lockfilePath: string,
  contents: LockfileContents,
): Promise<'created' | 'exists'> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // 'wx' = O_CREAT | O_EXCL: atomic create-if-absent. EEXIST if it already
    // exists. This is the mutual-exclusion primitive.
    fileHandle = await open(lockfilePath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw err;
  }
  try {
    await fileHandle.writeFile(JSON.stringify(contents), 'utf8');
  } finally {
    await fileHandle.close();
  }
  return 'created';
}

// Process-exit handlers are registered once, so a clean Ctrl+C (SIGINT) /
// SIGTERM / normal exit releases every lockfile we hold and the next run does not
// see a stale lock. Synchronous unlink on the exit path ('exit' handlers cannot
// await). Tracked in a set so we register one handler set and double-release is a
// no-op.
const heldLockfiles = new Set<string>();
let exitHandlersRegistered = false;

function unlinkSyncBestEffort(lockfilePath: string): void {
  try {
    unlinkSync(lockfilePath);
  } catch {
    // Already gone, or not ours to remove — nothing to do.
  }
}

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  const releaseAll = (): void => {
    for (const lockfilePath of heldLockfiles) unlinkSyncBestEffort(lockfilePath);
    heldLockfiles.clear();
  };
  process.on('exit', releaseAll);
  // On a signal, release the lockfile(s). Other SIGINT/SIGTERM listeners (e.g.
  // the MCP's graceful shutdown) still run; we only ensure the lockfile does not
  // outlive the process. We do NOT call process.exit here — that is left to the
  // process's own signal handling / default behaviour.
  process.on('SIGINT', releaseAll);
  process.on('SIGTERM', releaseAll);
}

// Acquire the advisory lock for a local PGlite data dir. Returns a handle whose
// `release()` removes the lockfile (idempotently). For an in-memory data dir
// there is nothing to lock, so a no-op handle is returned.
//
// Semantics on an existing lockfile:
//   - holder PID is alive  → throw LocalStoreLockedError (refuse).
//   - holder PID is dead, OR the lockfile is malformed → reclaim it (a previous
//     process crashed without releasing; the normal post-crash case must
//     self-heal, otherwise every crash needs a manual `rm`), then re-create.
export async function acquireLocalStoreLock(dataDir: string): Promise<PgliteLockHandle> {
  if (isInMemoryDataDir(dataDir)) {
    return { lockfilePath: '', release: async () => {} };
  }

  const lockfilePath = `${dataDir}.lock`;
  const contents: LockfileContents = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  };

  const first = await tryCreateLock(lockfilePath, contents);
  if (first === 'exists') {
    // Inspect the existing lock: reclaim if dead/malformed, refuse if alive.
    let existing: LockfileContents | undefined;
    try {
      existing = parseLockfile(await readFile(lockfilePath, 'utf8'));
    } catch {
      // Could not even read it (e.g. it vanished between create-attempt and
      // read) — fall through to a reclaim attempt.
      existing = undefined;
    }

    if (existing !== undefined && isProcessAlive(existing.pid)) {
      throw new LocalStoreLockedError(lockfilePath, existing);
    }

    // Stale (dead PID) or malformed: remove and re-create. unlink may race with
    // another reclaimer; tolerate ENOENT.
    try {
      await unlink(lockfilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const second = await tryCreateLock(lockfilePath, contents);
    if (second === 'exists') {
      // Someone else won the reclaim race and now holds it — re-read and refuse.
      let raced: LockfileContents | undefined;
      try {
        raced = parseLockfile(await readFile(lockfilePath, 'utf8'));
      } catch {
        raced = undefined;
      }
      throw new LocalStoreLockedError(lockfilePath, raced);
    }
  }

  heldLockfiles.add(lockfilePath);
  registerExitHandlers();

  let released = false;
  return {
    lockfilePath,
    release: async () => {
      if (released) return;
      released = true;
      heldLockfiles.delete(lockfilePath);
      try {
        // Only remove the lockfile if it is still OURS — guards against deleting
        // a lock a later process legitimately re-acquired after a crash window.
        const current = parseLockfile(await readFile(lockfilePath, 'utf8'));
        if (current !== undefined && current.pid !== process.pid) return;
        await unlink(lockfilePath);
      } catch {
        // Already gone, unreadable, or not ours — release is best-effort.
      }
    },
  };
}

// Read-only inspection of the advisory lock for a local data dir: does a LIVE
// process currently hold it? PURE — it never opens PGlite, never creates or
// removes a lockfile, and never throws. Returns `{ heldByLivePid }` only when a
// well-formed lockfile names a process that is alive on this host; returns null
// for every "free or reclaimable" state (no lockfile, in-memory data dir, a
// stale/dead-PID lock, or a malformed lockfile).
//
// This is the SAFE classifier `munin mcp doctor` uses BEFORE it tries to open
// the store: when a live holder is present (the user's AI client is running),
// the doctor reports an informational "in use" line instead of performing a
// destructive raw open against the held data dir. Synchronous (readFileSync) so
// doctor's check stays a simple straight-line probe. LOCAL-ONLY.
export function inspectLock(dataDir: string): { readonly heldByLivePid: number } | null {
  if (isInMemoryDataDir(dataDir)) return null;
  const lockfilePath = `${dataDir}.lock`;
  let raw: string;
  try {
    raw = readFileSync(lockfilePath, 'utf8');
  } catch {
    // No lockfile (ENOENT) or unreadable → treat as not held.
    return null;
  }
  const contents = parseLockfile(raw);
  if (contents === undefined) return null; // malformed → reclaimable, not "held"
  if (!isProcessAlive(contents.pid)) return null; // stale/dead PID → reclaimable
  return { heldByLivePid: contents.pid };
}

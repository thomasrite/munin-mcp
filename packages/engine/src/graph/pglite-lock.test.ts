// Advisory inter-process lock (F71) — real-filesystem behaviour, no mocked fs.
//
// Exercised against a real temp dir: acquire → refuse second acquire → release →
// re-acquire; a stale (dead-PID) lockfile is reclaimed; a malformed lockfile is
// reclaimed; an in-memory data dir is a no-op. The lock is the only guard against
// two processes opening the same local PGlite store, so its semantics are proven
// directly, not through PGlite.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalStoreLockedError,
  type LockfileContents,
  acquireLocalStoreLock,
  inspectLock,
} from './pglite-lock';

let tmp: string;
let dataDir: string;
let lockfilePath: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'munin-pglite-lock-'));
  dataDir = path.join(tmp, 'pgdata');
  lockfilePath = `${dataDir}.lock`;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('acquireLocalStoreLock', () => {
  it('acquires, writes our identity, and refuses a second acquire while held', async () => {
    const first = await acquireLocalStoreLock(dataDir);
    try {
      expect(first.lockfilePath).toBe(lockfilePath);
      const written = JSON.parse(await readFile(lockfilePath, 'utf8')) as LockfileContents;
      expect(written.pid).toBe(process.pid);
      expect(typeof written.startedAt).toBe('string');
      expect(written.hostname).toBe(os.hostname());

      // A second acquire over the SAME data dir, while the (alive) holder is us,
      // must refuse with the typed error carrying the holder identity.
      await expect(acquireLocalStoreLock(dataDir)).rejects.toBeInstanceOf(LocalStoreLockedError);
      try {
        await acquireLocalStoreLock(dataDir);
      } catch (err) {
        expect(err).toBeInstanceOf(LocalStoreLockedError);
        expect((err as LocalStoreLockedError).holder?.pid).toBe(process.pid);
      }
    } finally {
      await first.release();
    }
  });

  it('release removes the lockfile and a re-acquire then succeeds', async () => {
    const first = await acquireLocalStoreLock(dataDir);
    await first.release();
    // The lockfile is gone after release.
    await expect(readFile(lockfilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // Re-acquire over the same dir works.
    const second = await acquireLocalStoreLock(dataDir);
    try {
      const written = JSON.parse(await readFile(lockfilePath, 'utf8')) as LockfileContents;
      expect(written.pid).toBe(process.pid);
    } finally {
      await second.release();
    }
  });

  it('release is idempotent and does not throw on a second call', async () => {
    const handle = await acquireLocalStoreLock(dataDir);
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('reclaims a STALE lockfile whose PID is not alive', async () => {
    // A dead PID: a previous process that crashed without releasing. Pick a pid
    // that is overwhelmingly unlikely to be live (and prove it is not).
    const deadPid = 2_147_483_646;
    let dead = true;
    try {
      process.kill(deadPid, 0);
      dead = false; // it IS alive — skip the strong assertion below
    } catch {
      dead = true;
    }
    await writeFile(
      lockfilePath,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString(), hostname: 'old-host' }),
      'utf8',
    );

    if (dead) {
      const handle = await acquireLocalStoreLock(dataDir);
      try {
        // Reclaimed: the lockfile now records OUR pid.
        const written = JSON.parse(await readFile(lockfilePath, 'utf8')) as LockfileContents;
        expect(written.pid).toBe(process.pid);
      } finally {
        await handle.release();
      }
    }
  });

  it('reclaims a MALFORMED lockfile (not valid JSON / missing fields)', async () => {
    await writeFile(lockfilePath, 'this is not json', 'utf8');
    const handle = await acquireLocalStoreLock(dataDir);
    try {
      const written = JSON.parse(await readFile(lockfilePath, 'utf8')) as LockfileContents;
      expect(written.pid).toBe(process.pid);
    } finally {
      await handle.release();
    }

    // A structurally-JSON-but-missing-fields lockfile is also reclaimed.
    await writeFile(lockfilePath, JSON.stringify({ not: 'a lock' }), 'utf8');
    const handle2 = await acquireLocalStoreLock(dataDir);
    try {
      const written = JSON.parse(await readFile(lockfilePath, 'utf8')) as LockfileContents;
      expect(written.pid).toBe(process.pid);
    } finally {
      await handle2.release();
    }
  });

  it('is a no-op for an in-memory data dir (memory://, idb://, empty)', async () => {
    for (const inMemory of ['memory://', 'memory://x', 'idb://munin', '', '   ']) {
      const handle = await acquireLocalStoreLock(inMemory);
      expect(handle.lockfilePath).toBe('');
      // No file is created and release is safe.
      await expect(handle.release()).resolves.toBeUndefined();
    }
    // And a real acquire still works afterwards (no global state was poisoned).
    const handle = await acquireLocalStoreLock(dataDir);
    await handle.release();
  });
});

describe('inspectLock', () => {
  it('reports our own live pid while we hold the lock (read-only, no side effects)', async () => {
    const handle = await acquireLocalStoreLock(dataDir);
    try {
      const result = inspectLock(dataDir);
      expect(result).toEqual({ heldByLivePid: process.pid });
      // Pure: the probe did not remove or alter the lockfile.
      const written = JSON.parse(await readFile(lockfilePath, 'utf8')) as LockfileContents;
      expect(written.pid).toBe(process.pid);
    } finally {
      await handle.release();
    }
  });

  it('returns null when there is no lockfile (free store)', () => {
    expect(inspectLock(dataDir)).toBeNull();
  });

  it('returns null for a STALE lockfile whose PID is dead (reclaimable, not held)', async () => {
    const deadPid = 2_147_483_646;
    let dead = true;
    try {
      process.kill(deadPid, 0);
      dead = false;
    } catch {
      dead = true;
    }
    await writeFile(
      lockfilePath,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString(), hostname: 'old-host' }),
      'utf8',
    );
    if (dead) expect(inspectLock(dataDir)).toBeNull();
  });

  it('returns null for a MALFORMED lockfile (not JSON / missing fields)', async () => {
    await writeFile(lockfilePath, 'this is not json', 'utf8');
    expect(inspectLock(dataDir)).toBeNull();

    await writeFile(lockfilePath, JSON.stringify({ not: 'a lock' }), 'utf8');
    expect(inspectLock(dataDir)).toBeNull();
  });

  it('returns null for an in-memory data dir (nothing to lock)', () => {
    for (const inMemory of ['memory://', 'memory://x', 'idb://munin', '', '   ']) {
      expect(inspectLock(inMemory)).toBeNull();
    }
  });

  it('does not CREATE a lockfile as a side effect of probing a free store', async () => {
    expect(inspectLock(dataDir)).toBeNull();
    // The probe must not have created the lockfile — a subsequent acquire still
    // takes a fresh lock, and reading the lockfile before acquire fails ENOENT.
    await expect(readFile(lockfilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

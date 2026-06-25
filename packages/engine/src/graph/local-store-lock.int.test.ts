// loadGraphStore local-mode concurrency guard (F71).
//
// The factory must serialise on-disk PGlite opens: two GRAPH_STORE=local handles
// over the SAME data dir cannot both be open, because the second open would
// corrupt/lock the store (and surface as a raw WASM abort). This runs PGlite in-
// process against a real durable temp data dir (mirrors the read-audit factory
// integration test) — no Docker, hence the unit suite — and proves the advisory
// lock refuses the second open with LocalStoreLockedError, and that a fresh open
// succeeds once the first handle has closed (lock released).

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStoreLockedError, loadGraphStore } from './graph-store-factory';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'munin-local-lock-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Read auditing off keeps the test focused on the lock (and avoids the audit
// writer holding the connection); the lock is independent of it either way.
const env = (): NodeJS.ProcessEnv => ({
  GRAPH_STORE: 'local',
  PGLITE_DATA_DIR: dataDir,
  MUNIN_READ_AUDIT: 'false',
});

describe('loadGraphStore local-mode lock (F71)', () => {
  it('refuses a second open over the same data dir, then allows it after close', async () => {
    const first = await loadGraphStore(env());
    try {
      // Second open while the first holds the data dir → refused.
      await expect(loadGraphStore(env())).rejects.toBeInstanceOf(LocalStoreLockedError);
    } finally {
      await first.close();
    }

    // After the first handle closed (lock released), a fresh open succeeds.
    const third = await loadGraphStore(env());
    expect(third.store).toBeDefined();
    await third.close();
  }, 60_000);

  it('an in-memory data dir is never locked (memory:// opens freely twice)', async () => {
    const memEnv: NodeJS.ProcessEnv = {
      GRAPH_STORE: 'local',
      PGLITE_DATA_DIR: 'memory://',
      MUNIN_READ_AUDIT: 'false',
    };
    // Two independent in-memory stores are separate databases — no shared file,
    // no lock, no refusal.
    const a = await loadGraphStore(memEnv);
    const b = await loadGraphStore(memEnv);
    expect(a.store).toBeDefined();
    expect(b.store).toBeDefined();
    await a.close();
    await b.close();
  }, 60_000);
});

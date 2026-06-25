// Local-store CLI guidance: the lock PRE-FLIGHT (item 3) refuses up front when a
// live process holds the store; the dirty-store GUIDANCE (item 5) prints a
// one-command rebuild on a corrupt store with no live holder. Filesystem-only —
// no DB, no Docker; the "live lock" is a faked lockfile naming this process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStoreLockedError, LocalStoreUnavailableError } from '@muninhq/engine/graph-store';

import {
  preflightLocalStoreLock,
  rebuildCommand,
  reportLocalStoreError,
} from './local-store-errors';

// Write a lockfile naming THIS process (so isProcessAlive → true → "held").
function writeLiveLock(dataDir: string): void {
  fs.writeFileSync(
    `${dataDir}.lock`,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
    }),
  );
}

describe('rebuildCommand', () => {
  it('names the home derived from the data dir (pgdata lives under the home)', () => {
    expect(rebuildCommand('/Users/me/.munin/pgdata')).toBe(
      'rm -rf "/Users/me/.munin" && munin init',
    );
  });

  it('falls back to $MUNIN_HOME when the data dir is unknown', () => {
    expect(rebuildCommand(undefined)).toBe('rm -rf "$MUNIN_HOME" && munin init');
    expect(rebuildCommand('')).toBe('rm -rf "$MUNIN_HOME" && munin init');
  });
});

describe('preflightLocalStoreLock', () => {
  let base: string;
  let dataDir: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-preflight-')));
    dataDir = path.join(base, 'pgdata');
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('throws LocalStoreLockedError when a live holder is present (local mode)', () => {
    writeLiveLock(dataDir);
    expect(() =>
      preflightLocalStoreLock({ GRAPH_STORE: 'local', PGLITE_DATA_DIR: dataDir }),
    ).toThrow(LocalStoreLockedError);
  });

  it('is a no-op when no lockfile is present', () => {
    expect(() =>
      preflightLocalStoreLock({ GRAPH_STORE: 'local', PGLITE_DATA_DIR: dataDir }),
    ).not.toThrow();
  });

  it('is a no-op for the Postgres path even with a lockfile present', () => {
    writeLiveLock(dataDir);
    expect(() =>
      preflightLocalStoreLock({ GRAPH_STORE: 'postgres', PGLITE_DATA_DIR: dataDir }),
    ).not.toThrow();
  });

  it('is a no-op when PGLITE_DATA_DIR is unset', () => {
    expect(() => preflightLocalStoreLock({ GRAPH_STORE: 'local' })).not.toThrow();
  });
});

describe('reportLocalStoreError', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('reports a locked store as "in use by another process" and handles it', () => {
    const handled = reportLocalStoreError(new LocalStoreLockedError('/x/pgdata.lock', undefined));
    expect(handled).toBe(true);
    expect(errSpy.mock.calls[0]?.[0]).toMatch(/in use by another process/i);
  });

  it('guides a one-command rebuild on a corrupt store with NO live holder', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-dirty-')));
    try {
      const dataDir = path.join(base, 'pgdata'); // no lockfile → no live holder
      const handled = reportLocalStoreError(
        new LocalStoreUnavailableError('store aborted on open'),
        {
          dataDir,
        },
      );
      expect(handled).toBe(true);
      const printed = errSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain(`rm -rf "${base}" && munin init`);
      expect(printed).toMatch(/corrupt/i);
      expect(printed).toContain('munin set-key');
      expect(printed).toContain('munin ingest');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('treats a corrupt-looking open with a LIVE holder as the in-use case, not rebuild', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-dirty-race-')));
    try {
      const dataDir = path.join(base, 'pgdata');
      writeLiveLock(dataDir); // a client appeared between open and report (a race)
      reportLocalStoreError(new LocalStoreUnavailableError('store aborted on open'), { dataDir });
      const printed = errSpy.mock.calls[0]?.[0] as string;
      expect(printed).toMatch(/in use by another process/i);
      expect(printed).not.toContain('rm -rf');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns false (does not handle) an unrelated error', () => {
    expect(reportLocalStoreError(new Error('something else'))).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

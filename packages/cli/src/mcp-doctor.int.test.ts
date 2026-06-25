// Integration test for `munin mcp doctor` — runs against a real `munin init`
// home (PGlite, no Docker). Proves the checklist passes end-to-end AND that the
// output never echoes the AES blob key (the redaction guarantee).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { muninHomeLayout } from '@muninhq/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHomeInit } from './home-init';
import { parseEnvFile } from './local-init';
import type { ResolvePathDeps } from './mcp-connect';
import { allChecksOk, renderDoctorReport, runDoctor } from './mcp-doctor';

const BASE_ENV = {} as NodeJS.ProcessEnv;

describe('munin mcp doctor (PGlite home)', () => {
  let home: string;
  let clientHome: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-doctor-'));
    // A separate, empty "homedir" for client-config resolution → no real configs.
    clientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-doctor-client-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(clientHome, { recursive: true, force: true });
  });

  it('reports a wired setup and never prints the blob encryption key', async () => {
    await runHomeInit({ home, baseEnv: BASE_ENV });
    const layout = muninHomeLayout(home);
    const key = parseEnvFile(fs.readFileSync(layout.envPath, 'utf8')).get(
      'MUNIN_BLOB_ENCRYPTION_KEY',
    );
    expect(key).toBeTruthy();

    const pathDeps: ResolvePathDeps = { platform: 'linux', homedir: clientHome };
    const report = await runDoctor({
      home,
      env: BASE_ENV,
      pathDeps,
      // Stub Ollama so the test does not depend on a live daemon.
      ollamaPing: async () => ({ reachable: true, models: ['bge-m3', 'qwen2.5:7b'] }),
    });
    const out = renderDoctorReport(report.home, report.checks);

    // REDACTION: the key value must never appear in the rendered checklist.
    expect(out).not.toContain(key as string);

    // Wiring: the load-bearing checks pass.
    expect(out).toContain('✓ munin.env present');
    expect(out).toContain('✓ posture declared');
    expect(out).toContain('✓ local store opens');
    expect(out).toContain('✓ tenant resolves');
    expect(out).toContain('✓ configuration loads');
    expect(out).toContain('✓ providers configured');
    expect(out).toContain('✓ Ollama reachable');
    expect(out).toContain('5 tools');
    expect(allChecksOk(report.checks)).toBe(true);
  });

  it('fails the tenant check when MUNIN_TENANT_ID names no live tenant in the store', async () => {
    await runHomeInit({ home, baseEnv: BASE_ENV });
    const layout = muninHomeLayout(home);
    // Rewrite the pinned tenant to a bogus id (the store still holds the real one).
    const original = fs.readFileSync(layout.envPath, 'utf8');
    const bogus = '00000000-0000-4000-8000-0000deadbeef';
    fs.chmodSync(layout.envPath, 0o600);
    fs.writeFileSync(
      layout.envPath,
      original.replace(/MUNIN_TENANT_ID=.*/, `MUNIN_TENANT_ID=${bogus}`),
    );

    const report = await runDoctor({
      home,
      env: BASE_ENV,
      pathDeps: { platform: 'linux', homedir: clientHome },
      ollamaPing: async () => ({ reachable: true, models: ['bge-m3', 'qwen2.5:7b'] }),
    });
    const out = renderDoctorReport(report.home, report.checks);
    expect(out).toContain('✗ tenant resolves');
    expect(out).toContain(bogus);
    expect(allChecksOk(report.checks)).toBe(false);
  });

  it('reports the store as in-use (not failed) when a live process holds the lock', async () => {
    await runHomeInit({ home, baseEnv: BASE_ENV });
    const layout = muninHomeLayout(home);
    // Simulate a running AI client holding the F71 advisory lock: write a
    // well-formed lockfile naming THIS process (a live pid). The doctor must
    // detect the live holder via inspectLock and NOT attempt a destructive open.
    fs.writeFileSync(
      `${layout.pgliteDataDir}.lock`,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      }),
      'utf8',
    );

    const report = await runDoctor({
      home,
      env: BASE_ENV,
      pathDeps: { platform: 'linux', homedir: clientHome },
      ollamaPing: async () => ({ reachable: true, models: ['bge-m3', 'qwen2.5:7b'] }),
    });
    const out = renderDoctorReport(report.home, report.checks);

    // Informational `·` line, NOT a scary `✗ local store opens — ... corrupt`.
    expect(out).toContain('· local store — in use by your AI client');
    expect(out).toContain(`pid ${process.pid}`);
    expect(out).not.toContain('✗ local store opens');
    // The in-use state must not fail the run (no non-zero exit).
    expect(allChecksOk(report.checks)).toBe(true);
  });

  it('fails cleanly when there is no home (no munin.env)', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-doctor-empty-'));
    try {
      const report = await runDoctor({ home: empty, env: BASE_ENV });
      const out = renderDoctorReport(report.home, report.checks);
      expect(out).toContain('✗ munin.env present');
      expect(out).toContain('run `munin init`');
      expect(allChecksOk(report.checks)).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

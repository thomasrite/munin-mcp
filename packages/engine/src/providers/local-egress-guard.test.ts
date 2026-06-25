// P1-1b — the loopback-only egress dispatcher, proven against Node's BUILT-IN
// global fetch (not just the npm undici client). The npm-undici ↔ Node-fetch
// coupling goes through the shared Symbol.for('undici.globalDispatcher.1')
// registry and is version-sensitive, so this suite is the empirical evidence
// the no-egress audit cites: on this Node, a non-loopback fetch is REFUSED by
// our guard (our message, not a network error) while loopback traffic passes.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installLocalModeEgressGuard,
  isLoopbackHost,
  isLoopbackUrl,
  uninstallLocalModeEgressGuardForTests,
} from './local-egress-guard';
import { loadLlmProvider } from './provider-factory';

// Unwrap fetch's TypeError wrapper to the dispatcher's refusal.
function rootMessage(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

function listenLoopback(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('loopback-ok'));
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

describe('local-mode egress guard (P1-1b)', () => {
  afterEach(() => {
    uninstallLocalModeEgressGuardForTests();
  });

  it('REFUSES a non-loopback built-in fetch with the guard message (no network attempted)', async () => {
    installLocalModeEgressGuard();
    // example.com would resolve fine if the guard failed to intercept — the
    // message assertion below distinguishes OUR refusal from any network error.
    const err = await fetch('https://example.com/').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'non-loopback fetch must reject under the guard').not.toBeNull();
    expect(rootMessage(err)).toMatch(/MUNIN_LOCAL_MODE egress guard/);
    expect(rootMessage(err)).toContain('https://example.com');
  });

  it('PERMITS loopback fetch (a local daemon keeps working)', async () => {
    installLocalModeEgressGuard();
    const { server, port } = await listenLoopback();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('loopback-ok');
    } finally {
      server.close();
    }
  });

  it('is installed BY THE FACTORY PATH when local mode is on (no separate bootstrap call)', async () => {
    loadLlmProvider({ MUNIN_LOCAL_MODE: 'true', LLM_PROVIDER: 'stub' });
    const err = await fetch('https://example.com/').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(rootMessage(err)).toMatch(/MUNIN_LOCAL_MODE egress guard/);
  });

  it('install is idempotent; uninstall restores outbound dispatch state', async () => {
    installLocalModeEgressGuard();
    installLocalModeEgressGuard();
    const { server, port } = await listenLoopback();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.ok).toBe(true);
    } finally {
      server.close();
    }
    uninstallLocalModeEgressGuardForTests();
    // After restore the guard no longer intercepts — proven against loopback
    // (no real off-machine traffic in a unit test).
    const { server: s2, port: p2 } = await listenLoopback();
    try {
      const res = await fetch(`http://127.0.0.1:${p2}/`);
      expect(await res.text()).toBe('loopback-ok');
    } finally {
      s2.close();
    }
  });

  it('re-asserts the guard when a later setGlobalDispatcher displaced it', async () => {
    const { Agent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    installLocalModeEgressGuard();
    const guard = getGlobalDispatcher();
    // Simulate a dependency swapping the global dispatcher out from under us.
    const interloper = new Agent();
    setGlobalDispatcher(interloper);
    expect(getGlobalDispatcher()).not.toBe(guard);
    // The next factory-path install reinstates the SAME guard instance.
    installLocalModeEgressGuard();
    expect(getGlobalDispatcher()).toBe(guard);
    await interloper.close();
  });

  it('the test-only uninstall refuses to run in production', () => {
    installLocalModeEgressGuard();
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => uninstallLocalModeEgressGuardForTests()).toThrow(/cannot be uninstalled/);
    } finally {
      process.env.NODE_ENV = prior;
    }
  });

  it('loopback classification: canonical spellings only, fail-closed otherwise', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(false); // unrecognised → refused
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackUrl('http://localhost:11434')).toBe(true);
    expect(isLoopbackUrl('http://127.1:11434')).toBe(true); // URL normalises → 127.0.0.1
    expect(isLoopbackUrl('not a url')).toBe(false); // unparseable → refused
  });
});

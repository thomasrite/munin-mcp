// Loopback-only egress dispatcher for MUNIN_LOCAL_MODE (P1-1b, G1).
//
// The PRIMARY no-egress guard is structural: the provider factory REFUSES to
// construct any provider that would send bytes off-machine (see
// provider-factory.ts). This module is the defence-in-depth second layer — a
// process-global undici dispatcher, installed when local mode is on, that
// permits LOOPBACK destinations only. Any future direct-fetch code path (a
// connector, a stray helper using global fetch) then fails at the socket
// layer even if it never went through the factory.
//
// HONEST SCOPE. The dispatcher intercepts undici-routed traffic: Node's
// built-in global `fetch` (Node's fetch reads the dispatcher set via the
// shared `Symbol.for('undici.globalDispatcher.1')` registry — npm undici and
// the Node-bundled copy cooperate through it; verified empirically on Node 22
// by local-egress-guard.test.ts, because that coupling is version-sensitive)
// and anything using the npm `undici` client directly. It does NOT cover:
//   • `node:https`-based SDKs (the AWS/Anthropic/OpenAI SDKs) — covered by
//     the factory refusal instead: in local mode they are never constructed;
//   • a PER-REQUEST dispatcher (`fetch(url, { dispatcher })` /
//     `undici.request(url, { dispatcher })`) — first-party code opting out of
//     the global dispatcher deliberately;
//   • a later `setGlobalDispatcher()` call displacing the guard — partially
//     mitigated: every factory call in local mode RE-ASSERTS the guard (a
//     displaced dispatcher is reinstalled), but code that displaces it and
//     never constructs a provider again stays displaced.
// All three routes require first-party code; the structural factory refusal
// (layer 1) remains the primary guarantee.
//
// The guard is deliberately one-way in production: there is no public
// uninstall. The test-only restore refuses to run under NODE_ENV=production.

import { Agent, type Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

// The canonical loopback spellings — an ALLOWLIST, so unrecognised forms
// (LAN addresses, 0.0.0.0, 127.0.0.2) fail closed. The URL parser already
// normalises 127.1 / 2130706433 / 0x7f000001 → 127.0.0.1. Single source of
// truth shared with the provider factory's endpoint checks.
export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

// Is this URL's host loopback? Unparseable URLs fail closed (false).
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Node's built-in fetch hands dispatch a LEGACY-shape handler (onError),
// which undici 8's published DispatchHandler type no longer declares; npm
// undici 8 clients use the NEW shape (onResponseError). Cover both — the
// guard test proves the built-in-fetch path empirically.
type CompatDispatchHandler = Dispatcher.DispatchHandler & {
  readonly onError?: (err: Error) => void;
};

// Refuses any dispatch whose origin is not loopback; delegates loopback
// dispatches to a real Agent. The refusal is synchronous and local — no DNS
// lookup, no socket is ever opened for a refused origin.
class LoopbackOnlyDispatcher extends Agent {
  override dispatch(opts: Agent.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = String(opts.origin ?? '');
    if (!isLoopbackUrl(origin)) {
      const err = new Error(
        `MUNIN_LOCAL_MODE egress guard: refused non-loopback request to '${origin}'. Local mode permits loopback (localhost/127.0.0.1/::1) destinations only.`,
      );
      const compat = handler as CompatDispatchHandler;
      if (typeof compat.onError === 'function') {
        compat.onError(err);
        return false;
      }
      if (typeof compat.onResponseError === 'function') {
        // reason: the controller is unused by error-only consumers and no
        // request controller exists for a dispatch that was never started.
        compat.onResponseError(
          undefined as unknown as Parameters<
            NonNullable<Dispatcher.DispatchHandler['onResponseError']>
          >[0],
          err,
        );
        return false;
      }
      // No error channel at all — fail loudly rather than silently dispatching.
      throw err;
    }
    return super.dispatch(opts, handler);
  }
}

let installed: LoopbackOnlyDispatcher | null = null;
let previous: Dispatcher | null = null;

// Install the loopback-only dispatcher process-wide. Idempotent — repeated
// factory calls in local mode keep exactly one dispatcher — and
// displacement-resistant: if some later code swapped the global dispatcher
// out (`setGlobalDispatcher` from a dependency), the next factory call in
// local mode RE-ASSERTS the guard rather than trusting module state.
export function installLocalModeEgressGuard(): void {
  if (installed !== null) {
    if (getGlobalDispatcher() !== installed) setGlobalDispatcher(installed);
    return;
  }
  previous = getGlobalDispatcher();
  installed = new LoopbackOnlyDispatcher();
  setGlobalDispatcher(installed);
}

// TEST-ONLY restore. Production local mode never uninstalls the guard — the
// privacy promise is for the life of the process.
export function uninstallLocalModeEgressGuardForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('the local-mode egress guard cannot be uninstalled in production');
  }
  if (installed === null) return;
  if (previous !== null) setGlobalDispatcher(previous);
  void installed.close();
  installed = null;
  previous = null;
}

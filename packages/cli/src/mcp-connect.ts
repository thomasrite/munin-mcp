// `munin mcp connect` core (F68 / S1) — generate the client mcpServers block
// and (with --write) idempotently, safely merge it into the client's config.
//
// SAFETY POSTURE (the whole point of --write):
//   • print/dry-run by DEFAULT — nothing on disk is touched without --write;
//   • refuse a SYMLINK target (we don't write through links — --config-path /
//     --project can point anywhere);
//   • refuse an UNPARSEABLE existing config (never clobber JSON we can't read);
//   • MERGE, never clobber — set only mcpServers.<name>; preserve every other
//     top-level key and every other mcpServers.* entry; identical → no-op;
//   • BACKUP (O_EXCL) the existing file, then ATOMIC write (temp file in the
//     same REAL directory, then rename) so a crash can't leave a half-file and
//     the swap can't escape via a parent symlink.
//
// NO SECRETS in the emitted block — only a MUNIN_HOME pointer and a hardened
// PATH (see Node-version pinning below). The settings (including the AES key)
// live in $MUNIN_HOME/munin.env, never in client JSON.
//
// INSTALLED vs CHECKOUT launcher (the `munin-mcp` executable). The block must
// point the client at the right MCP server entrypoint, and that differs between:
//   • a dev CHECKOUT — the server runs from the repo via `pnpm --dir
//     <checkout>/packages/mcp --silent start`; the executable lives in the repo;
//   • a real INSTALL (global or local node_modules) — the server is the published
//     `munin-mcp` bin shipped by @muninhq/mcp, run directly as `<node> <binPath>`,
//     with no pnpm and no checkout. This is what lets `munin mcp connect` wire a
//     globally/locally-installed user (closing the "stranger installs it" loop).
// resolveLaunchTarget decides which by resolving the installed bin (see below).
//
// PORTABILITY across a home/machine move (Stage B). Two paths a client config
// carries are machine-specific: (1) the MUNIN_HOME pointer, and (2) the launcher
// itself — the checkout `--dir`/pinned-Node, or the installed bin path/pinned
// Node. We make (1) relocatable: when `home` is the per-user DEFAULT (~/.munin),
// the emitted block OMITS MUNIN_HOME so the launcher resolves the default on
// whatever machine/user runs the client — a default-home block survives being
// copied to another machine. A non-default `--home` stays baked (it has no
// portable form). (2) is this-machine-only in BOTH forms (the absolute checkout
// or install path plus the pinned Node), so after moving to a different
// checkout/machine the user re-runs `munin mcp connect`. The CLI prints this
// limitation; `result.homeBaked` + `result.launchMode` tell it which note to show.
//
// Pure helpers (entry/config/merge/path) are exported for unit tests; runConnect
// orchestrates them and is the one function the CLI calls.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export type McpClient = 'claude-desktop' | 'cursor';

export const DEFAULT_SERVER_NAME = 'munin';

export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/**
 * Where the MCP server executable lives — the one thing that differs between a
 * dev CHECKOUT and a real INSTALL:
 *   • checkout  — the server runs from the repo via `pnpm --dir <mcpDir> … start`;
 *   • installed — the published `munin-mcp` bin (`@muninhq/mcp` dist), run directly
 *     as `<node> <binPath>` with no pnpm and no checkout.
 */
export type LaunchTarget =
  | { readonly kind: 'checkout'; readonly mcpDir: string }
  | { readonly kind: 'installed'; readonly binPath: string };

/**
 * Resolve the published `munin-mcp` bin shipped by an INSTALLED `@muninhq/mcp`, or
 * undefined when we are NOT running from an install (a dev checkout).
 *
 * The discriminator is the `bin` field of the resolved `@muninhq/mcp/package.json`:
 *   • installed → `./dist/main.js` (publishConfig.bin, applied at pack/publish) —
 *     a compiled, node-runnable entrypoint; we return its absolute path.
 *   • checkout  → `./src/main.ts` (the workspace package.json) — a TS file that
 *     cannot run under plain node; we return undefined so connect keeps the pnpm
 *     dev launcher. (publishConfig.bin is applied only at pack/publish, so a built
 *     `dist/` in a checkout does NOT flip this — the checkout package.json still
 *     names the .ts bin.)
 *
 * Runtime-only resolution via createRequire — NEVER a static `import` of
 * `@muninhq/mcp` (that would create a TYPE/build coupling we don't want; the only
 * runtime coupling we need is "find the installed server's compiled bin path").
 * `@muninhq/mcp` is a declared runtime dependency of `munin-mcp` so that a single
 * `npm install -g munin-mcp` pulls the MCP server too and this resolution
 * succeeds: in an install the declared dep is present under `node_modules` and
 * resolves directly; in a checkout the workspace symlink resolves but yields the
 * `.ts` bin (→ undefined → checkout). The reverse edge (`@muninhq/mcp` →
 * `munin-mcp`) is DEV/TEST-only, so there is no runtime dependency cycle.
 */
export function resolveInstalledMcpBin(cliModuleUrl: string): string | undefined {
  try {
    const req = createRequire(cliModuleUrl);
    const pkgJsonPath = req.resolve('@muninhq/mcp/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['munin-mcp'];
    if (typeof rel !== 'string') return undefined;
    const abs = path.resolve(path.dirname(pkgJsonPath), rel);
    // Only an actually-runnable compiled JS bin counts as "installed". This
    // hard-codes `.js` to match @muninhq/mcp's publishConfig.bin (`./dist/main.js`,
    // emitted by the esm-fix build): a `.ts` bin is the checkout shape, and any
    // other extension would (deliberately) fall back to checkout. If the mcp
    // build ever emits `.mjs`/`.cjs`, widen this guard in lockstep.
    if (!abs.endsWith('.js') || !fs.existsSync(abs)) return undefined;
    return abs;
  } catch {
    return undefined;
  }
}

export interface ResolveLaunchTargetDeps {
  /** import.meta.url of the running CLI module — the base for require() resolution. */
  readonly cliModuleUrl: string;
  /** The repo `packages/mcp` dir, used for the checkout (pnpm) launcher. */
  readonly checkoutMcpDir: string;
  /** Injectable installed-bin resolver (tests pass a deterministic one). */
  readonly resolveInstalledBin?: (cliModuleUrl: string) => string | undefined;
}

/**
 * Decide whether `munin mcp connect` should emit the INSTALLED-bin launcher (the
 * running `munin` came from a node_modules install — global or local) or the dev
 * CHECKOUT launcher. The decision is made purely by resolving the installed
 * `munin-mcp` bin (see resolveInstalledMcpBin); a successful resolution means
 * installed, otherwise we fall back to the repo checkout.
 */
export function resolveLaunchTarget(deps: ResolveLaunchTargetDeps): LaunchTarget {
  const resolve = deps.resolveInstalledBin ?? resolveInstalledMcpBin;
  const binPath = resolve(deps.cliModuleUrl);
  if (binPath !== undefined) return { kind: 'installed', binPath };
  return { kind: 'checkout', mcpDir: deps.checkoutMcpDir };
}

// --- Node-version pinning (the fix for the nvm "Server disconnected" bug) -----
//
// A bare `command: "pnpm"` lets the client's spawn resolve `pnpm` — and then
// pnpm's own `node` — off whatever PATH the client inherits. Under nvm that can
// be an OLD Node (v18), where the launcher crashes with `File is not defined`
// (undici) and the client just shows "Server disconnected". So the emitted
// block must pin a Node-22-capable launcher: the exact Node + pnpm that `munin
// mcp connect` itself is running under (it ran under Node 22, by construction).

export interface LauncherEnv {
  /** process.execPath — the Node binary running connect (guaranteed ≥22 here). */
  readonly execPath: string;
  /** process.env.npm_execpath — the package-manager JS entry, set when connect is
   * launched via pnpm. Used to pin pnpm itself. */
  readonly npmExecPath?: string;
  /** process.env.PATH at connect time. */
  readonly path?: string;
  /** path.delimiter (':' on POSIX, ';' on Windows) — injectable for tests. */
  readonly pathDelimiter?: string;
}

export interface ResolvedLauncher {
  readonly command: string;
  /** Args BEFORE the `--dir <mcpDir> --silent start` tail (the pnpm JS when pinned). */
  readonly argsPrefix: readonly string[];
  /** Extra env merged into the block (a PATH that leads with Node's bin dir). */
  readonly env: Record<string, string>;
  /** True when BOTH the runtime and pnpm are absolute-pinned (not PATH-resolved). */
  readonly pinned: boolean;
}

export function defaultLauncherEnv(env: NodeJS.ProcessEnv = process.env): LauncherEnv {
  return {
    execPath: process.execPath,
    ...(env.npm_execpath ? { npmExecPath: env.npm_execpath } : {}),
    ...(env.PATH ? { path: env.PATH } : {}),
    pathDelimiter: path.delimiter,
  };
}

/**
 * Resolve a launcher that cannot grab a broken Node. Always prepends the dir of
 * the running Node to PATH (so pnpm → tsx → node resolve Node 22 first). When
 * connect is itself running under pnpm (npm_execpath names pnpm), also pin pnpm:
 * run its JS entry with THIS Node — then neither `pnpm` nor `node` is looked up
 * on PATH at all. Otherwise keep `pnpm` as the command (now PATH-hardened); the
 * launcher's args are pnpm-specific (`--dir`/`start`), so we never pin a
 * different package manager.
 */
export function resolveNodeLauncher(le: LauncherEnv): ResolvedLauncher {
  const nodeBinDir = path.dirname(le.execPath);
  const delim = le.pathDelimiter ?? path.delimiter;
  const pathValue = le.path ? `${nodeBinDir}${delim}${le.path}` : nodeBinDir;
  const env: Record<string, string> = { PATH: pathValue };

  const isPnpm = le.npmExecPath !== undefined && /pnpm/i.test(path.basename(le.npmExecPath));
  if (isPnpm && le.npmExecPath !== undefined) {
    return { command: le.execPath, argsPrefix: [le.npmExecPath], env, pinned: true };
  }
  return { command: 'pnpm', argsPrefix: [], env, pinned: false };
}

/**
 * The node-direct launcher for the INSTALLED form: run the published `munin-mcp`
 * bin with the exact Node that connect ran under (≥22 by construction), so the
 * client can never spawn it under a stray old Node. No pnpm is involved — the bin
 * is plain compiled JS — so this form is ALWAYS pinned (safe to --write). The
 * PATH still leads with that Node's bin dir for any subprocess.
 */
export function resolveInstalledLauncher(le: LauncherEnv, binPath: string): ResolvedLauncher {
  const nodeBinDir = path.dirname(le.execPath);
  const delim = le.pathDelimiter ?? path.delimiter;
  const pathValue = le.path ? `${nodeBinDir}${delim}${le.path}` : nodeBinDir;
  return { command: le.execPath, argsPrefix: [binPath], env: { PATH: pathValue }, pinned: true };
}

/**
 * Resolve the launcher for a target: the node-direct installed-bin launcher for
 * an INSTALL, or the pnpm Node-pinning resolver for a CHECKOUT.
 */
export function resolveLauncherForTarget(target: LaunchTarget, le: LauncherEnv): ResolvedLauncher {
  return target.kind === 'installed'
    ? resolveInstalledLauncher(le, target.binPath)
    : resolveNodeLauncher(le);
}

/**
 * The client command, by target:
 *   • installed → `<pinned node> <binPath>` (the published `munin-mcp` bin, run
 *     directly — no pnpm, no checkout);
 *   • checkout  → `<pinned node> <pnpm.cjs> --dir <mcpDir> --silent start` (or
 *     `pnpm --dir <mcpDir> --silent start` with a Node-22-led PATH on fallback).
 * The JSON carries only a MUNIN_HOME pointer plus a hardened PATH — never a
 * secret.
 */
export function buildMcpServerEntry(opts: {
  target: LaunchTarget;
  home: string;
  launcher?: ResolvedLauncher;
  /**
   * The per-user default home (`resolveMuninHome` with no env). When provided AND
   * `home` equals it, MUNIN_HOME is OMITTED from the emitted env so the launcher
   * resolves the default ~/.munin on whatever machine/user runs the client — a
   * default-home block survives a relocation. Omit this arg to ALWAYS bake
   * MUNIN_HOME (the conservative legacy shape used by the pure-unit callers).
   */
  defaultHome?: string;
}): McpServerEntry {
  const launcher = opts.launcher ?? resolveLauncherForTarget(opts.target, defaultLauncherEnv());
  // INSTALLED: argsPrefix already IS the full command tail (`[binPath]`).
  // CHECKOUT:  append the `--dir <mcpDir> --silent start` tail after the prefix
  //            (`[pnpm.cjs]` when pinned, or `[]` for the bare-pnpm fallback).
  const args =
    opts.target.kind === 'installed'
      ? [...launcher.argsPrefix]
      : [...launcher.argsPrefix, '--dir', opts.target.mcpDir, '--silent', 'start'];
  const bakeHome =
    opts.defaultHome === undefined || path.resolve(opts.home) !== path.resolve(opts.defaultHome);
  return {
    command: launcher.command,
    args,
    // Bake MUNIN_HOME only for a non-default home; a default home is omitted so it
    // resolves per-user (portable). The hardened PATH always rides along.
    env: { ...(bakeHome ? { MUNIN_HOME: opts.home } : {}), ...launcher.env },
  };
}

export function buildClientConfig(
  name: string,
  entry: McpServerEntry,
): { mcpServers: Record<string, McpServerEntry> } {
  return { mcpServers: { [name]: entry } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge our server entry into an existing parsed config. Preserves all other
 * top-level keys and all other mcpServers.* entries; sets only mcpServers.<name>.
 * A non-object existing value (or non-object mcpServers) is treated as absent.
 */
export function mergeMcpServerConfig(
  existing: unknown,
  name: string,
  entry: McpServerEntry,
): Record<string, unknown> {
  const base = isPlainObject(existing) ? { ...existing } : {};
  const servers = isPlainObject(base.mcpServers) ? { ...base.mcpServers } : {};
  servers[name] = entry;
  base.mcpServers = servers;
  return base;
}

export interface ResolvePathDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** %APPDATA% on Windows (from env.APPDATA). */
  readonly appData?: string;
}

export function defaultPathDeps(env: NodeJS.ProcessEnv = process.env): ResolvePathDeps {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    ...(env.APPDATA ? { appData: env.APPDATA } : {}),
  };
}

export interface ClientPathOptions {
  readonly client: McpClient;
  /** Explicit override — wins over the per-client default. */
  readonly configPath?: string;
  /** Cursor only: write the project-local .cursor/mcp.json instead of global. */
  readonly project?: string;
}

/**
 * Resolve the client's config file path. Defaults per OS:
 *   claude-desktop — macOS ~/Library/Application Support/Claude/claude_desktop_config.json;
 *                    Windows %APPDATA%\Claude\claude_desktop_config.json;
 *                    Linux ~/.config/claude-desktop/claude_desktop_config.json.
 *   cursor         — ~/.cursor/mcp.json (global), or <project>/.cursor/mcp.json.
 */
export function clientConfigPath(opts: ClientPathOptions, deps: ResolvePathDeps): string {
  if (opts.configPath) return path.resolve(opts.configPath);

  // Build with the TARGET platform's path semantics, so the result is correct
  // (and testable) regardless of the host the command runs on.
  const p = deps.platform === 'win32' ? path.win32 : path.posix;

  if (opts.client === 'cursor') {
    if (opts.project) return p.join(p.resolve(opts.project), '.cursor', 'mcp.json');
    return p.join(deps.homedir, '.cursor', 'mcp.json');
  }

  // claude-desktop
  if (deps.platform === 'darwin') {
    return p.join(
      deps.homedir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (deps.platform === 'win32') {
    const appData = deps.appData ?? p.join(deps.homedir, 'AppData', 'Roaming');
    return p.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return p.join(deps.homedir, '.config', 'claude-desktop', 'claude_desktop_config.json');
}

export type ConnectAction = 'printed' | 'written' | 'unchanged' | 'refused';
// 'unpinned-node' — the resolved launcher is a bare `pnpm` that re-resolves Node
// from PATH (connect was not run under pnpm, so npm_execpath did not name pnpm).
// We refuse to PERSIST that shape because a client spawning it under an old Node
// (the nvm "Server disconnected" / `File is not defined` crash) is a prime
// "died mid-write" corruption trigger — see resolveNodeLauncher.
export type RefusalReason = 'symlink' | 'unparseable' | 'unpinned-node';

export interface ConnectResult {
  readonly action: ConnectAction;
  readonly targetPath: string;
  /** Pretty-printed mcpServers block (always present — for printing/pasting). */
  readonly block: string;
  /** Whether the emitted launcher pins an explicit Node binary + pnpm.cjs (true)
   * or is a bare PATH-resolved `pnpm` (false). --write requires true. */
  readonly pinned: boolean;
  /** Whether MUNIN_HOME was baked into the block (a non-default home) or omitted
   * so it resolves to the per-user default (portable). Drives the CLI's
   * portability note. */
  readonly homeBaked: boolean;
  /** Which launcher form was emitted — 'installed' (the published `munin-mcp`
   * bin) or 'checkout' (pnpm `--dir` the repo). Drives the CLI's portability note. */
  readonly launchMode: LaunchTarget['kind'];
  /** The full merged file content (present when written or unchanged). */
  readonly mergedConfig?: string;
  /** Path of the backup created before an overwrite. */
  readonly backupPath?: string;
  readonly refusalReason?: RefusalReason;
}

export interface RunConnectOptions {
  readonly client: McpClient;
  /** Where the `munin-mcp` executable lives — installed bin vs repo checkout. */
  readonly target: LaunchTarget;
  readonly home: string;
  /** The per-user default home; when `home` equals it, MUNIN_HOME is omitted from
   * the block so it resolves per-user (portable). See buildMcpServerEntry. */
  readonly defaultHome?: string;
  readonly name?: string;
  readonly write?: boolean;
  readonly configPath?: string;
  readonly project?: string;
  readonly deps?: ResolvePathDeps;
  /** Injectable launcher resolution (tests pass a deterministic one). */
  readonly launcher?: ResolvedLauncher;
  /** Injectable for deterministic backup names in tests. */
  readonly timestamp?: () => string;
}

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function runConnect(opts: RunConnectOptions): ConnectResult {
  const name = opts.name ?? DEFAULT_SERVER_NAME;
  const deps = opts.deps ?? defaultPathDeps();
  const targetPath = clientConfigPath(
    {
      client: opts.client,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      ...(opts.project ? { project: opts.project } : {}),
    },
    deps,
  );

  // Resolve the launcher up front (for the target) so we know whether it is
  // PINNED before we decide to write: the --write guard below must never persist
  // a bare-`pnpm` shim that re-resolves Node from PATH. The installed-bin launcher
  // is always pinned (it runs the absolute Node directly), so the guard only ever
  // fires for the checkout fallback.
  const launchMode = opts.target.kind;
  const launcher = opts.launcher ?? resolveLauncherForTarget(opts.target, defaultLauncherEnv());
  const entry = buildMcpServerEntry({
    target: opts.target,
    home: opts.home,
    launcher,
    ...(opts.defaultHome !== undefined ? { defaultHome: opts.defaultHome } : {}),
  });
  const block = JSON.stringify(buildClientConfig(name, entry), null, 2);
  // Did the block bake MUNIN_HOME (non-default home) or omit it (portable default)?
  const homeBaked = entry.env.MUNIN_HOME !== undefined;

  if (!opts.write) {
    return { action: 'printed', targetPath, block, pinned: launcher.pinned, homeBaked, launchMode };
  }

  // --- write path ----------------------------------------------------------
  // HARD GUARD (the Node-version-pinning fix): only the pinned
  // `<node> <pnpm.cjs> …` form may be persisted. An unpinned resolution means
  // connect was not launched under pnpm (npm_execpath did not name pnpm), so we
  // cannot pin pnpm.cjs — refuse rather than write a launcher the client could
  // spawn under an old Node. In production `munin mcp connect` runs as a pnpm
  // script, so this never fires; it is a defence against a stray invocation.
  if (!launcher.pinned) {
    return {
      action: 'refused',
      targetPath,
      block,
      pinned: false,
      homeBaked,
      launchMode,
      refusalReason: 'unpinned-node',
    };
  }

  let existingRaw: string | undefined;
  const stat = lstatOrUndefined(targetPath);
  if (stat) {
    if (stat.isSymbolicLink()) {
      return {
        action: 'refused',
        targetPath,
        block,
        pinned: true,
        homeBaked,
        launchMode,
        refusalReason: 'symlink',
      };
    }
    existingRaw = fs.readFileSync(targetPath, 'utf8');
  }

  let parsed: unknown = {};
  if (existingRaw !== undefined && existingRaw.trim() !== '') {
    try {
      parsed = JSON.parse(existingRaw);
    } catch {
      return {
        action: 'refused',
        targetPath,
        block,
        pinned: true,
        homeBaked,
        launchMode,
        refusalReason: 'unparseable',
      };
    }
  }

  const merged = mergeMcpServerConfig(parsed, name, entry);
  const mergedConfig = `${JSON.stringify(merged, null, 2)}\n`;

  // Idempotent: identical content already on disk → no-op (re-run is a fixed point).
  if (existingRaw === mergedConfig) {
    return {
      action: 'unchanged',
      targetPath,
      block,
      pinned: true,
      homeBaked,
      launchMode,
      mergedConfig,
    };
  }

  // Ensure the parent dir exists, then write atomically within its REAL path so
  // the rename can't escape through a parent symlink.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const realDir = fs.realpathSync(path.dirname(targetPath));
  const finalPath = path.join(realDir, path.basename(targetPath));

  let backupPath: string | undefined;
  if (existingRaw !== undefined) {
    backupPath = `${finalPath}.munin-backup-${(opts.timestamp ?? backupTimestamp)()}`;
    // O_EXCL: never overwrite an existing backup.
    fs.copyFileSync(finalPath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const tmpPath = path.join(
    realDir,
    `.munin-connect-${process.pid}-${(opts.timestamp ?? backupTimestamp)()}.tmp`,
  );
  fs.writeFileSync(tmpPath, mergedConfig);
  fs.renameSync(tmpPath, finalPath);

  return {
    action: 'written',
    targetPath: finalPath,
    block,
    pinned: true,
    homeBaked,
    launchMode,
    mergedConfig,
    ...(backupPath ? { backupPath } : {}),
  };
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

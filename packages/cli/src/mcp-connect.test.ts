import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type LaunchTarget,
  type LauncherEnv,
  type McpServerEntry,
  type ResolvePathDeps,
  type ResolvedLauncher,
  buildClientConfig,
  buildMcpServerEntry,
  clientConfigPath,
  mergeMcpServerConfig,
  resolveInstalledLauncher,
  resolveInstalledMcpBin,
  resolveLaunchTarget,
  resolveLauncherForTarget,
  resolveNodeLauncher,
  runConnect,
} from './mcp-connect';

const MCP_DIR = '/repo/packages/mcp';
const HOME = '/Users/alice/.munin';

// The dev-checkout launch target used by the existing (pnpm `--dir`) tests.
const CHECKOUT: LaunchTarget = { kind: 'checkout', mcpDir: MCP_DIR };
// An installed launch target: the published `munin-mcp` bin shipped by @muninhq/mcp.
const INSTALLED_BIN = '/usr/local/lib/node_modules/@muninhq/mcp/dist/main.js';
const INSTALLED: LaunchTarget = { kind: 'installed', binPath: INSTALLED_BIN };

// A Node-22-ish launcher env, as connect would see it when run under pnpm.
const NODE_22 = '/Users/alice/.nvm/versions/node/v22.22.0/bin/node';
const PNPM_JS = '/Users/alice/.nvm/versions/node/v22.22.0/lib/node_modules/pnpm/bin/pnpm.cjs';
const pnpmEnv: LauncherEnv = {
  execPath: NODE_22,
  npmExecPath: PNPM_JS,
  path: '/usr/bin:/bin',
  pathDelimiter: ':',
};

// A pinned launcher (run under pnpm) and an unpinned one (a bare `pnpm` shim).
// The test runner's ambient env is unpinned (pnpm exec does not set
// npm_execpath), so the --write tests inject PINNED to reflect the production
// path (`pnpm … munin`, a run-script, which DOES set npm_execpath).
const PINNED: ResolvedLauncher = resolveNodeLauncher(pnpmEnv);
const UNPINNED: ResolvedLauncher = {
  command: 'pnpm',
  argsPrefix: [],
  env: { PATH: '/node22/bin:/usr/bin' },
  pinned: false,
};

describe('resolveNodeLauncher (Node-version pinning)', () => {
  it('pins BOTH node and pnpm when connect runs under pnpm', () => {
    const r = resolveNodeLauncher(pnpmEnv);
    expect(r.pinned).toBe(true);
    // command is the ABSOLUTE Node 22 binary, never a bare "pnpm"/"node".
    expect(r.command).toBe(NODE_22);
    // pnpm is pinned by running its JS entry with that node.
    expect(r.argsPrefix).toEqual([PNPM_JS]);
  });

  it('leads PATH with the running Node’s bin dir so spawned tools resolve Node 22', () => {
    const r = resolveNodeLauncher(pnpmEnv);
    expect(r.env.PATH).toBe('/Users/alice/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin');
  });

  it('falls back to bare pnpm (still PATH-hardened) when npm_execpath is not pnpm', () => {
    const npmEnv: LauncherEnv = {
      execPath: NODE_22,
      npmExecPath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      path: '/usr/bin',
      pathDelimiter: ':',
    };
    const r = resolveNodeLauncher(npmEnv);
    expect(r.pinned).toBe(false);
    // We never pin a different package manager with pnpm-specific args.
    expect(r.command).toBe('pnpm');
    expect(r.argsPrefix).toEqual([]);
    // But the PATH still leads with Node 22's bin dir.
    expect(r.env.PATH).toBe('/Users/alice/.nvm/versions/node/v22.22.0/bin:/usr/bin');
  });

  it('falls back when npm_execpath is absent, and handles an empty PATH', () => {
    const r = resolveNodeLauncher({ execPath: NODE_22, pathDelimiter: ':' });
    expect(r.pinned).toBe(false);
    expect(r.command).toBe('pnpm');
    expect(r.env.PATH).toBe('/Users/alice/.nvm/versions/node/v22.22.0/bin');
  });
});

describe('buildMcpServerEntry', () => {
  it('emits the pinned node + pnpm launcher with MUNIN_HOME and a hardened PATH', () => {
    const launcher: ResolvedLauncher = resolveNodeLauncher(pnpmEnv);
    const entry = buildMcpServerEntry({ target: CHECKOUT, home: HOME, launcher });
    expect(entry.command).toBe(NODE_22);
    expect(entry.args).toEqual([PNPM_JS, '--dir', MCP_DIR, '--silent', 'start']);
    expect(entry.env.MUNIN_HOME).toBe(HOME);
    expect(entry.env.PATH).toContain('/v22.22.0/bin');
    // No secret keys ever appear in the block.
    expect(JSON.stringify(entry)).not.toMatch(/API_KEY|ENCRYPTION_KEY/);
  });

  it('emits the fallback pnpm launcher (still PATH-hardened) when not pinned', () => {
    const launcher: ResolvedLauncher = {
      command: 'pnpm',
      argsPrefix: [],
      env: { PATH: '/node22/bin:/usr/bin' },
      pinned: false,
    };
    const entry = buildMcpServerEntry({ target: CHECKOUT, home: HOME, launcher });
    expect(entry.command).toBe('pnpm');
    expect(entry.args).toEqual(['--dir', MCP_DIR, '--silent', 'start']);
    expect(entry.env).toEqual({ MUNIN_HOME: HOME, PATH: '/node22/bin:/usr/bin' });
  });

  // Portability (Stage B): a default home omits MUNIN_HOME so it resolves per-user.
  it('OMITS MUNIN_HOME when the home is the per-user default (portable block)', () => {
    const launcher = resolveNodeLauncher(pnpmEnv);
    const entry = buildMcpServerEntry({
      target: CHECKOUT,
      home: HOME,
      launcher,
      defaultHome: HOME,
    });
    expect(entry.env.MUNIN_HOME).toBeUndefined();
    // The hardened PATH still rides along; the launcher is unchanged + pinned.
    expect(entry.env.PATH).toContain('/v22.22.0/bin');
    expect(entry.command).toBe(NODE_22);
  });

  it('BAKES MUNIN_HOME for a NON-default home (no portable form)', () => {
    const launcher = resolveNodeLauncher(pnpmEnv);
    const entry = buildMcpServerEntry({
      target: CHECKOUT,
      home: '/srv/custom-home',
      launcher,
      defaultHome: HOME,
    });
    expect(entry.env.MUNIN_HOME).toBe('/srv/custom-home');
  });

  it('BAKES MUNIN_HOME (legacy shape) when no defaultHome is supplied', () => {
    const entry = buildMcpServerEntry({ target: CHECKOUT, home: HOME });
    expect(entry.env.MUNIN_HOME).toBe(HOME);
  });

  // INSTALLED form: `<node> <binPath>` — no pnpm, no `--dir`, no checkout path.
  it('emits the installed-bin launcher: <node> <binPath> with NO --dir/start tail', () => {
    const launcher = resolveInstalledLauncher(pnpmEnv, INSTALLED_BIN);
    const entry = buildMcpServerEntry({ target: INSTALLED, home: HOME, launcher });
    expect(entry.command).toBe(NODE_22);
    expect(entry.args).toEqual([INSTALLED_BIN]);
    // The dev-launcher markers must be ABSENT — this is what proves it does not
    // point at a repo checkout.
    expect(entry.args).not.toContain('--dir');
    expect(entry.args).not.toContain('start');
    expect(JSON.stringify(entry)).not.toContain(MCP_DIR);
    expect(entry.env.MUNIN_HOME).toBe(HOME);
    expect(entry.env.PATH).toContain('/v22.22.0/bin');
  });

  it('installed form OMITS MUNIN_HOME for the per-user default home (portable)', () => {
    const launcher = resolveInstalledLauncher(pnpmEnv, INSTALLED_BIN);
    const entry = buildMcpServerEntry({
      target: INSTALLED,
      home: HOME,
      launcher,
      defaultHome: HOME,
    });
    expect(entry.env.MUNIN_HOME).toBeUndefined();
    expect(entry.args).toEqual([INSTALLED_BIN]);
    expect(entry.command).toBe(NODE_22);
  });
});

describe('resolveInstalledLauncher', () => {
  it('pins the absolute Node, runs the bin directly, and is ALWAYS pinned', () => {
    const r = resolveInstalledLauncher(pnpmEnv, INSTALLED_BIN);
    expect(r.command).toBe(NODE_22);
    expect(r.argsPrefix).toEqual([INSTALLED_BIN]);
    // No pnpm involved, so the launcher is pinned regardless of how connect ran —
    // this is what lets a globally-installed (non-pnpm) user --write safely.
    expect(r.pinned).toBe(true);
    // PATH still leads with Node 22's bin dir.
    expect(r.env.PATH).toBe('/Users/alice/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin');
  });

  it('handles an empty PATH (just the Node bin dir)', () => {
    const r = resolveInstalledLauncher({ execPath: NODE_22, pathDelimiter: ':' }, INSTALLED_BIN);
    expect(r.env.PATH).toBe('/Users/alice/.nvm/versions/node/v22.22.0/bin');
  });
});

describe('resolveLauncherForTarget', () => {
  it('dispatches to the installed launcher for an installed target', () => {
    const r = resolveLauncherForTarget(INSTALLED, pnpmEnv);
    expect(r.argsPrefix).toEqual([INSTALLED_BIN]);
    expect(r.command).toBe(NODE_22);
  });

  it('dispatches to the pnpm Node-pinning launcher for a checkout target', () => {
    const r = resolveLauncherForTarget(CHECKOUT, pnpmEnv);
    expect(r.argsPrefix).toEqual([PNPM_JS]);
  });
});

describe('resolveLaunchTarget (installed-vs-checkout detection)', () => {
  it('INSTALLED when the installed munin-mcp bin resolves', () => {
    const t = resolveLaunchTarget({
      cliModuleUrl: 'file:///x/node_modules/munin-mcp/dist/munin-cli.js',
      checkoutMcpDir: MCP_DIR,
      resolveInstalledBin: () => INSTALLED_BIN,
    });
    expect(t).toEqual({ kind: 'installed', binPath: INSTALLED_BIN });
  });

  it('CHECKOUT when no installed bin resolves (dev/workspace)', () => {
    const t = resolveLaunchTarget({
      cliModuleUrl: 'file:///repo/packages/cli/src/munin-cli.ts',
      checkoutMcpDir: MCP_DIR,
      resolveInstalledBin: () => undefined,
    });
    expect(t).toEqual({ kind: 'checkout', mcpDir: MCP_DIR });
  });
});

describe('resolveInstalledMcpBin (real require resolution)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-resolve-')));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Lay out a fake install: a running munin-mcp + a sibling @muninhq/mcp whose
   *  package.json `bin` and dist contents we control. Returns the cli module url. */
  function fakeInstall(opts: {
    bin: string | Record<string, string>;
    writeBinFile?: string;
  }): string {
    const cliDir = path.join(root, 'node_modules', 'munin-mcp', 'dist');
    const mcpDir = path.join(root, 'node_modules', '@muninhq', 'mcp');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    const cliModule = path.join(cliDir, 'munin-cli.js');
    fs.writeFileSync(cliModule, '// fake cli');
    fs.writeFileSync(
      path.join(mcpDir, 'package.json'),
      JSON.stringify({ name: '@muninhq/mcp', version: '0.1.0', bin: opts.bin }),
    );
    if (opts.writeBinFile) {
      const abs = path.join(mcpDir, opts.writeBinFile);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '#!/usr/bin/env node\n');
    }
    return pathToFileURL(cliModule).href;
  }

  it('resolves the installed dist/main.js bin (publishConfig shape)', () => {
    const url = fakeInstall({
      bin: { 'munin-mcp': './dist/main.js' },
      writeBinFile: 'dist/main.js',
    });
    const resolved = resolveInstalledMcpBin(url);
    expect(resolved).toBe(path.join(root, 'node_modules', '@muninhq', 'mcp', 'dist', 'main.js'));
  });

  it('returns undefined for the checkout shape (bin is ./src/main.ts)', () => {
    // The workspace package.json names a .ts bin (publishConfig is applied only at
    // pack/publish) — not runnable under plain node, so it must NOT count as installed.
    const url = fakeInstall({ bin: { 'munin-mcp': './src/main.ts' }, writeBinFile: 'src/main.ts' });
    expect(resolveInstalledMcpBin(url)).toBeUndefined();
  });

  it('returns undefined when the .js bin does not exist on disk', () => {
    const url = fakeInstall({ bin: { 'munin-mcp': './dist/main.js' } }); // no file written
    expect(resolveInstalledMcpBin(url)).toBeUndefined();
  });

  it('returns undefined when @muninhq/mcp cannot be resolved at all', () => {
    const cliDir = path.join(root, 'node_modules', 'munin-mcp', 'dist');
    fs.mkdirSync(cliDir, { recursive: true });
    const cliModule = path.join(cliDir, 'munin-cli.js');
    fs.writeFileSync(cliModule, '// fake cli, no sibling mcp');
    expect(resolveInstalledMcpBin(pathToFileURL(cliModule).href)).toBeUndefined();
  });
});

describe('buildClientConfig', () => {
  it('nests the entry under mcpServers.<name>', () => {
    const entry = buildMcpServerEntry({ target: CHECKOUT, home: HOME });
    expect(buildClientConfig('munin', entry)).toEqual({ mcpServers: { munin: entry } });
  });
});

describe('clientConfigPath', () => {
  const mac: ResolvePathDeps = { platform: 'darwin', homedir: '/Users/alice' };
  const win: ResolvePathDeps = {
    platform: 'win32',
    homedir: 'C:\\Users\\alice',
    appData: 'C:\\Users\\alice\\AppData\\Roaming',
  };
  const linux: ResolvePathDeps = { platform: 'linux', homedir: '/home/alice' };

  it('claude-desktop on macOS', () => {
    expect(clientConfigPath({ client: 'claude-desktop' }, mac)).toBe(
      '/Users/alice/Library/Application Support/Claude/claude_desktop_config.json',
    );
  });

  it('claude-desktop on Windows uses %APPDATA%', () => {
    expect(clientConfigPath({ client: 'claude-desktop' }, win)).toBe(
      path.win32.join('C:\\Users\\alice\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'),
    );
  });

  it('claude-desktop on Linux uses ~/.config/claude-desktop', () => {
    expect(clientConfigPath({ client: 'claude-desktop' }, linux)).toBe(
      '/home/alice/.config/claude-desktop/claude_desktop_config.json',
    );
  });

  it('cursor defaults to the global ~/.cursor/mcp.json', () => {
    expect(clientConfigPath({ client: 'cursor' }, mac)).toBe('/Users/alice/.cursor/mcp.json');
  });

  it('cursor --project writes <project>/.cursor/mcp.json', () => {
    expect(clientConfigPath({ client: 'cursor', project: '/work/app' }, mac)).toBe(
      '/work/app/.cursor/mcp.json',
    );
  });

  it('--config-path overrides the per-client default', () => {
    expect(clientConfigPath({ client: 'claude-desktop', configPath: '/tmp/c.json' }, mac)).toBe(
      '/tmp/c.json',
    );
  });
});

describe('mergeMcpServerConfig', () => {
  const entry: McpServerEntry = buildMcpServerEntry({ target: CHECKOUT, home: HOME });

  it('adds our server to an empty config', () => {
    expect(mergeMcpServerConfig({}, 'munin', entry)).toEqual({ mcpServers: { munin: entry } });
  });

  it('preserves other mcpServers entries and other top-level keys', () => {
    const existing = {
      theme: 'dark',
      mcpServers: { other: { command: 'node', args: ['x.js'] } },
    };
    const merged = mergeMcpServerConfig(existing, 'munin', entry);
    expect(merged.theme).toBe('dark');
    expect((merged.mcpServers as Record<string, unknown>).other).toEqual({
      command: 'node',
      args: ['x.js'],
    });
    expect((merged.mcpServers as Record<string, unknown>).munin).toEqual(entry);
  });

  it('replaces only our entry on re-merge (idempotent)', () => {
    const once = mergeMcpServerConfig({ mcpServers: { other: { command: 'x' } } }, 'munin', entry);
    const twice = mergeMcpServerConfig(once, 'munin', entry);
    expect(twice).toEqual(once);
  });

  it('treats a non-object existing config as absent', () => {
    expect(mergeMcpServerConfig('garbage', 'munin', entry)).toEqual({
      mcpServers: { munin: entry },
    });
    expect(mergeMcpServerConfig(null, 'munin', entry)).toEqual({ mcpServers: { munin: entry } });
  });
});

describe('runConnect', () => {
  let tmp: string;
  const deps: ResolvePathDeps = { platform: 'linux', homedir: '/home/alice' };
  const T = () => 'STAMP';

  beforeEach(() => {
    // realpath so assertions match the atomic-write's realpath-resolved target
    // (macOS /var → /private/var symlink would otherwise differ).
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-connect-')));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints by default and touches nothing', () => {
    const target = path.join(tmp, 'nested', 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      deps,
    });
    expect(r.action).toBe('printed');
    expect(r.block).toContain('"MUNIN_HOME"');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('--write creates the file (and parent dirs) with our server', () => {
    const target = path.join(tmp, 'nested', 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
      launcher: PINNED,
    });
    expect(r.action).toBe('written');
    expect(r.backupPath).toBeUndefined(); // nothing to back up
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.mcpServers.munin.env.MUNIN_HOME).toBe(HOME);
  });

  it('--write writes the PINNED node + pnpm.cjs launcher, never a bare pnpm', () => {
    const target = path.join(tmp, 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
      launcher: PINNED,
    });
    expect(r.action).toBe('written');
    expect(r.pinned).toBe(true);
    const entry = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.munin;
    // command is the absolute Node 22 binary, args[0] is pnpm.cjs — never a bare shim.
    expect(entry.command).toBe(NODE_22);
    expect(entry.command).not.toBe('pnpm');
    expect(entry.args[0]).toBe(PNPM_JS);
    expect(entry.args).toEqual([PNPM_JS, '--dir', MCP_DIR, '--silent', 'start']);
  });

  it('--write REFUSES an unpinned (bare pnpm) launcher and writes nothing', () => {
    const target = path.join(tmp, 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      launcher: UNPINNED,
    });
    expect(r.action).toBe('refused');
    expect(r.refusalReason).toBe('unpinned-node');
    expect(r.pinned).toBe(false);
    // Nothing was persisted — the bare-pnpm shape never reaches disk.
    expect(fs.existsSync(target)).toBe(false);
  });

  it('printed reports pinned:false for an unpinned launcher (so the CLI can warn)', () => {
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: path.join(tmp, 'claude.json'),
      deps,
      launcher: UNPINNED,
    });
    expect(r.action).toBe('printed');
    expect(r.pinned).toBe(false);
  });

  it('--write is a fixed point (re-run → unchanged, no new backup)', () => {
    const target = path.join(tmp, 'claude.json');
    const opts = {
      client: 'claude-desktop' as const,
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
      launcher: PINNED,
    };
    runConnect(opts);
    const r2 = runConnect(opts);
    expect(r2.action).toBe('unchanged');
    // Exactly one file remains (no backup spawned on the no-op).
    expect(fs.readdirSync(path.dirname(target))).toEqual(['claude.json']);
  });

  it('--write merges, preserving an existing server + top-level key, and backs up', () => {
    const target = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'node' } } }, null, 2),
    );
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
      launcher: PINNED,
    });
    expect(r.action).toBe('written');
    expect(r.backupPath).toBe(`${target}.munin-backup-STAMP`);
    expect(fs.existsSync(r.backupPath as string)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.other).toEqual({ command: 'node' });
    expect(parsed.mcpServers.munin.env.MUNIN_HOME).toBe(HOME);
  });

  it('refuses to write through a symlink', () => {
    const real = path.join(tmp, 'real.json');
    fs.writeFileSync(real, '{}');
    const link = path.join(tmp, 'link.json');
    fs.symlinkSync(real, link);
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: link,
      write: true,
      deps,
      launcher: PINNED,
    });
    expect(r.action).toBe('refused');
    expect(r.refusalReason).toBe('symlink');
    // The real file is untouched.
    expect(fs.readFileSync(real, 'utf8')).toBe('{}');
  });

  it('refuses to write over unparseable JSON', () => {
    const target = path.join(tmp, 'claude.json');
    fs.writeFileSync(target, '{ this is not json');
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      launcher: PINNED,
    });
    expect(r.action).toBe('refused');
    expect(r.refusalReason).toBe('unparseable');
    expect(fs.readFileSync(target, 'utf8')).toBe('{ this is not json');
  });

  // Portability (Stage B): a default home produces a relocatable block (no baked
  // MUNIN_HOME); a non-default home is baked. The checkout --dir path is the
  // documented residual that always remains.
  it('a DEFAULT home → homeBaked:false and the block omits MUNIN_HOME', () => {
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      defaultHome: HOME,
      configPath: path.join(tmp, 'claude.json'),
      deps,
      launcher: PINNED,
    });
    expect(r.action).toBe('printed');
    expect(r.homeBaked).toBe(false);
    expect(r.block).not.toContain('MUNIN_HOME');
    // Documented residual: the absolute checkout path is STILL in the launcher.
    expect(r.block).toContain(MCP_DIR);
  });

  it('a NON-default home → homeBaked:true and the block bakes MUNIN_HOME', () => {
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: '/srv/other',
      defaultHome: HOME,
      configPath: path.join(tmp, 'claude.json'),
      deps,
      launcher: PINNED,
    });
    expect(r.homeBaked).toBe(true);
    expect(r.block).toContain('"MUNIN_HOME": "/srv/other"');
  });

  it('--write persists a default-home block WITHOUT MUNIN_HOME, launcher still pinned', () => {
    const target = path.join(tmp, 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      defaultHome: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
      launcher: PINNED,
    });
    expect(r.action).toBe('written');
    expect(r.homeBaked).toBe(false);
    const entry = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.munin;
    expect(entry.env.MUNIN_HOME).toBeUndefined();
    // Node-22 pinning is intact, and the checkout path (residual) is still present.
    expect(entry.command).toBe(NODE_22);
    expect(entry.args).toEqual([PNPM_JS, '--dir', MCP_DIR, '--silent', 'start']);
  });

  it('checkout mode reports launchMode:"checkout"', () => {
    const r = runConnect({
      client: 'claude-desktop',
      target: CHECKOUT,
      home: HOME,
      configPath: path.join(tmp, 'claude.json'),
      deps,
      launcher: PINNED,
    });
    expect(r.launchMode).toBe('checkout');
  });

  // INSTALLED form: the launcher points at the published munin-mcp bin, NOT a repo
  // checkout — the fix that wires a globally/locally-installed user.
  it('installed printed block points at the installed bin and omits the checkout path', () => {
    const r = runConnect({
      client: 'claude-desktop',
      target: INSTALLED,
      home: HOME,
      configPath: path.join(tmp, 'claude.json'),
      deps,
      launcher: resolveInstalledLauncher(pnpmEnv, INSTALLED_BIN),
    });
    expect(r.action).toBe('printed');
    expect(r.launchMode).toBe('installed');
    expect(r.block).toContain(INSTALLED_BIN);
    // It must NOT look like the dev launcher.
    expect(r.block).not.toContain('--dir');
    expect(r.block).not.toContain(MCP_DIR);
  });

  it('installed --write SUCCEEDS even when NOT run under pnpm (always pinned)', () => {
    // No injected launcher → real resolution via resolveInstalledLauncher, which
    // pins process.execPath directly. This is the key property for a stranger who
    // `npm i -g` (no pnpm in sight): the unpinned-node --write refusal never fires.
    const target = path.join(tmp, 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: INSTALLED,
      home: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
    });
    expect(r.action).toBe('written');
    expect(r.pinned).toBe(true);
    expect(r.launchMode).toBe('installed');
    const entry = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.munin;
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([INSTALLED_BIN]);
    expect(JSON.stringify(entry)).not.toContain(MCP_DIR);
  });

  it('installed default-home block omits MUNIN_HOME (portable) and still runs the bin', () => {
    const target = path.join(tmp, 'claude.json');
    const r = runConnect({
      client: 'claude-desktop',
      target: INSTALLED,
      home: HOME,
      defaultHome: HOME,
      configPath: target,
      write: true,
      deps,
      timestamp: T,
    });
    expect(r.action).toBe('written');
    expect(r.homeBaked).toBe(false);
    const entry = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.munin;
    expect(entry.env.MUNIN_HOME).toBeUndefined();
    expect(entry.args).toEqual([INSTALLED_BIN]);
  });
});

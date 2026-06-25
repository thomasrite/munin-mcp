#!/usr/bin/env node
// `munin` — the one-command dispatcher for the local easy-connect flow (F68/S1).
//
//   munin init                          bootstrap ~/.munin (munin.env + data + tenant)
//   munin ingest <dir>                  ingest a folder into the home's memory
//   munin extract [status]              build the local knowledge graph (in-process)
//   munin mcp connect --client <c>      print (or --write) the client mcpServers block
//   munin mcp doctor                    show the setup is wired (✓/✗ checklist)
//
// Runnable as `pnpm --filter munin-mcp munin …` today, and `munin …` once a
// bin is PATH-linked. Hand-rolled arg parsing (no new dependency). The
// ingest/extract subcommands load $MUNIN_HOME/munin.env first, so the data
// steps are home-aware and checkout-free for config (v1 still needs the checkout
// to RUN — see packages/mcp/README.md for the honest boundary).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type MuninHomeLayout, muninHomeLayout, resolveMuninHome } from '@muninhq/shared';
import { config as loadEnv } from 'dotenv';

import { runExtractCli } from './extract-cli';
import { runHomeInit } from './home-init';
import { runIngest } from './ingest-cli';
import { IngestDirectoryError } from './ingest-path';
import { LocalInitRefusalError } from './local-init';
import { reportLocalStoreError } from './local-store-errors';
import { type McpClient, type RefusalReason, resolveLaunchTarget, runConnect } from './mcp-connect';
import { allChecksOk, renderDoctorReport, runDoctor } from './mcp-doctor';
import { pickFolder, runAdd } from './munin-add';
import { formatDocsList, parseDocsLimit, runDocsList } from './munin-docs';
import { parseForgetArgs, runForget } from './munin-forget';
import { type KeyVar, formatSetKeySummary, runSetKey } from './munin-set-key';
import { type SetupActions, createInteractivePrompts, runSetup } from './munin-setup';
import { formatStatus, runStatus } from './munin-status';
import { applyLocalReadAuditMigration } from './read-audit-migration';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const mcpDir = path.join(repoRoot, 'packages', 'mcp');

// Decide ONCE whether the MCP launcher should point at the published `munin-mcp`
// bin (this `munin` resolves from a node_modules install — global or local) or
// the repo checkout (`pnpm --dir <mcpDir>`). The installed form is what wires a
// stranger who `npm i -g munin-mcp @muninhq/mcp` with no repo at all; a dev
// checkout keeps the existing pnpm launcher. See resolveLaunchTarget.
const launchTarget = resolveLaunchTarget({ cliModuleUrl: import.meta.url, checkoutMcpDir: mcpDir });

const HELP = `munin — local easy-connect for the Munin MCP server

usage:
  munin setup [--home <dir>] [--client claude-desktop|cursor]
      ★ Start here. One guided, resumable walkthrough from nothing to a working,
      Claude-connected memory: provision the home, choose an AI provider, add a
      folder of files, wire your AI client, and verify — narrating when to quit
      and restart the client. Re-run any time; it skips what is already done and
      never wipes your data. Orchestrates the commands below; runs none twice.

  munin init [--home <dir>]
      Bootstrap a portable home (default ~/.munin): writes munin.env (mode 0600),
      creates the PGlite + encrypted-blob dirs, and provisions your local tenant.

  munin ingest <dir> [--tags a,b] [--tenant <uuid>] [--home <dir>] [--force-reingest]
      Ingest a folder of documents into the home's memory. --tenant defaults to
      the home's MUNIN_TENANT_ID; --tags defaults to "personal".

  munin add [--tags a,b] [--tenant <uuid>] [--home <dir>]
      Pick a folder with the native macOS chooser and ingest it — no typing a
      path (which kills shell quoting / space-padding mistakes). Same defaults as
      \`munin ingest\`. Off macOS, falls back to \`munin ingest <folder>\`.

  munin extract [status] [--tenant <uuid>] [--home <dir>] [--re-extract]
      Build (or report) the local knowledge graph in-process (JOBS=inline).

  munin docs [--limit <n>] [--tenant <uuid>] [--home <dir>]
      List the documents in the home's memory (newest first), with ids you can
      read via munin_get_document. References the erase path for removal.

  munin forget <documentId> [--commit --confirm-title "<title>"] [--tenant <uuid>] [--home <dir>]
      Erase a document and everything derived from it. DRY-RUN BY DEFAULT: prints
      what WOULD be erased (title, source, paragraph/entity counts, the blob) and
      deletes nothing. To erase for real — HARD, atomic and IRREVERSIBLE (no undo)
      — re-run with --commit and the exact title via --confirm-title.

  munin status [--tenant <uuid>] [--home <dir>]
      Show corpus health (no LLM call): tenant, configuration, document/paragraph/
      entity/edge counts, paragraphs pending extraction, store posture, the home
      path, and recent documents.

  munin set-key anthropic|openai [--key <value>] [--home <dir>]
      Add a cloud provider key for GOOD extraction (and, with openai, FAST cloud
      embeddings). Writes munin.env at mode 0600, points LLM/EMBEDDING + models
      at the provider, and flips the posture to MUNIN_ALLOW_CLOUD_PROVIDERS
      (egress acknowledged). The key is never printed. Prefer the provider's
      env var (ANTHROPIC_API_KEY / OPENAI_API_KEY) over --key to keep the key
      out of your shell history.

  munin mcp connect --client claude-desktop|cursor [--write] [--home <dir>]
                    [--name <n>] [--config-path <path>] [--project <dir>]
      Print the client mcpServers block by default; --write merges it safely
      (backup + atomic + symlink-refusal, never clobbers other servers).

  munin mcp doctor [--home <dir>]
      Show the setup is wired: home, posture, store, tenant, config, providers,
      Ollama, tool count, and which clients reference \`munin\`.

  New here? Just run \`munin setup\` — it walks the whole sequence for you.
  Otherwise: run \`munin mcp connect\` after \`munin init\`, then restart your AI client.`;

// ---- arg helpers (hand-rolled) --------------------------------------------

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  // Treat a missing value, or another flag, as "no value" — never consume the
  // next flag as this flag's value (`--home --tags x` must not name a home
  // `--tags`), and `--home` at the end falls back to the default rather than
  // resolving to undefined-as-a-path.
  if (value === undefined || value.startsWith('-')) return undefined;
  return value;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/** Remove a flag (and its value, if `withValue`) from an argv list. */
export function stripFlag(argv: readonly string[], name: string, withValue: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      if (withValue) i++;
      continue;
    }
    const v = argv[i];
    if (v !== undefined) out.push(v);
  }
  return out;
}

function resolveHome(argv: readonly string[]): string {
  const fromFlag = flagValue(argv, '--home');
  return path.resolve(fromFlag ?? resolveMuninHome(process.env));
}

/**
 * Append the `munin`-level ingest defaults to an argv unless the caller already
 * supplied them: `--tenant` from the home's MUNIN_TENANT_ID, and `--tags personal`.
 * Shared by `ingest` and `add` so both inherit identical home-aware defaults.
 */
export function appendIngestDefaults(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const out = [...args];
  const tenant = env.MUNIN_TENANT_ID?.trim();
  if (!out.includes('--tenant') && !out.includes('-t') && tenant) {
    out.push('--tenant', tenant);
  }
  if (!out.includes('--tags')) {
    out.push('--tags', 'personal');
  }
  return out;
}

/** Where the `munin set-key` api key came from (drives the shell-history nudge). */
export type KeySource = 'flag' | 'positional' | 'env' | 'none';

/**
 * Resolve the api key for `munin set-key <provider> [key]`. Precedence: an
 * explicit `--key` flag, then a POSITIONAL key (the first bare token after the
 * provider — what a user naturally types: `munin set-key openai sk-...`), then
 * the provider's env var (the recommended path, since it stays out of shell
 * history). Value-bearing flags (`--key`/`--home`) are skipped so their values
 * are never mistaken for the key. Pure — unit-tested.
 */
export function resolveSetKeyInput(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  keyVar: KeyVar,
): { key: string | undefined; source: KeySource } {
  const flagged = flagValue(argv, '--key');
  if (flagged) return { key: flagged, source: 'flag' };
  // argv[0] is the provider positional; the key is the first bare token after it.
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === '--key' || tok === '--home') {
      i++; // skip the flag's value too
      continue;
    }
    if (tok.startsWith('-')) continue;
    return { key: tok, source: 'positional' };
  }
  const fromEnv = env[keyVar]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: undefined, source: 'none' };
}

/** Load $home/munin.env into process.env and derive the data dirs (mirrors the
 * MCP launcher) so the ingest/extract cores read the home's config. */
function loadHomeIntoProcessEnv(home: string): MuninHomeLayout {
  const layout = muninHomeLayout(home);
  if (fs.existsSync(layout.envPath)) loadEnv({ path: layout.envPath, override: true });
  if (!process.env.PGLITE_DATA_DIR?.trim()) process.env.PGLITE_DATA_DIR = layout.pgliteDataDir;
  if (!process.env.BLOB_STORAGE_FS_ROOT?.trim())
    process.env.BLOB_STORAGE_FS_ROOT = layout.blobFsRoot;
  return layout;
}

// ---- commands -------------------------------------------------------------

async function cmdInit(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  const result = await runHomeInit({ home, log: (l) => console.log(l) });
  console.log(`
Munin home ready at ${result.home}
  tenant:        ${result.tenantId}
  config:        ${result.configPackage}

Next:
  1. ollama pull bge-m3 && ollama pull qwen2.5:7b   (one-time; https://ollama.com)
  2. munin ingest /path/to/your/docs
  3. munin extract
  4. munin mcp connect --client claude-desktop --write   (then restart the client)
  5. munin mcp doctor                                     (verify it is wired)

(Or skip the manual sequence: \`munin setup\` runs all of this as one guided flow.)`);
}

async function cmdIngest(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  loadHomeIntoProcessEnv(home);
  const rest = stripFlag(argv, '--home', true);
  await runIngest(appendIngestDefaults(rest, process.env));
}

async function cmdAdd(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  loadHomeIntoProcessEnv(home);
  // `add` takes NO path (the native picker provides it); only the optional
  // --tags/--tenant flags carry through, defaulted exactly as `ingest` defaults
  // them. runAdd prepends the picked folder and hands off to runIngest verbatim.
  const rest = stripFlag(argv, '--home', true);
  const result = await runAdd(appendIngestDefaults(rest, process.env), {
    pickFolder,
    // runIngest now returns an IngestSummary, but `add` doesn't use it (only the
    // setup wizard reads the new-document count) — discard it to match runAdd's
    // void `ingest` dep without widening that interface.
    ingest: async (a) => {
      await runIngest(a);
    },
    log: (l) => console.log(l),
    logError: (l) => console.error(l),
  });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

async function cmdExtract(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  loadHomeIntoProcessEnv(home);
  const rest = stripFlag(argv, '--home', true);
  const args = [...rest];
  const tenant = process.env.MUNIN_TENANT_ID?.trim();
  if (!args.includes('--tenant') && !args.includes('-t') && tenant) {
    args.push('--tenant', tenant);
  }
  await runExtractCli(args);
}

async function cmdDocs(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  loadHomeIntoProcessEnv(home);
  const tenant = flagValue(argv, '--tenant') ?? process.env.MUNIN_TENANT_ID?.trim();
  if (!tenant) {
    throw new Error('no tenant: pass --tenant <uuid> or run `munin init` to provision one');
  }
  const configPackage = process.env.MUNIN_CONFIG_PACKAGE?.trim();
  if (!configPackage) {
    throw new Error('MUNIN_CONFIG_PACKAGE is unset — run `munin init` (or set it in munin.env)');
  }
  const limitRaw = flagValue(argv, '--limit');
  const limit = limitRaw !== undefined ? parseDocsLimit(limitRaw) : undefined;
  const view = await runDocsList({
    configPackage,
    tenantId: tenant,
    home,
    ...(limit !== undefined ? { limit } : {}),
  });
  console.log(formatDocsList(view));
}

async function cmdForget(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  loadHomeIntoProcessEnv(home);
  const tenant = flagValue(argv, '--tenant') ?? process.env.MUNIN_TENANT_ID?.trim();
  if (!tenant) {
    throw new Error('no tenant: pass --tenant <uuid> or run `munin init` to provision one');
  }
  const configPackage = process.env.MUNIN_CONFIG_PACKAGE?.trim();
  if (!configPackage) {
    throw new Error('MUNIN_CONFIG_PACKAGE is unset — run `munin init` (or set it in munin.env)');
  }
  const parsed = parseForgetArgs(argv);
  if (!parsed.documentId) {
    throw new Error(
      'usage: munin forget <documentId> [--commit --confirm-title "<title>"] (dry-run by default)',
    );
  }
  const result = await runForget({
    documentId: parsed.documentId,
    commit: parsed.commit,
    ...(parsed.confirmTitle !== undefined ? { confirmTitle: parsed.confirmTitle } : {}),
    configPackage,
    tenantId: tenant,
  });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

async function cmdStatus(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  loadHomeIntoProcessEnv(home);
  const tenant = flagValue(argv, '--tenant') ?? process.env.MUNIN_TENANT_ID?.trim();
  if (!tenant) {
    throw new Error('no tenant: pass --tenant <uuid> or run `munin init` to provision one');
  }
  const configPackage = process.env.MUNIN_CONFIG_PACKAGE?.trim();
  if (!configPackage) {
    throw new Error('MUNIN_CONFIG_PACKAGE is unset — run `munin init` (or set it in munin.env)');
  }
  const { status, posture } = await runStatus({ configPackage, tenantId: tenant, home });
  console.log(formatStatus(status, posture));
}

async function cmdSetKey(argv: readonly string[]): Promise<void> {
  const provider = argv[0];
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error('munin set-key requires a provider: anthropic | openai');
  }
  const home = resolveHome(argv);
  const keyVar: KeyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  // Accept the key positionally (`munin set-key openai sk-...`), via --key, or
  // from the provider's env var. Never read from the home file — set-key only
  // writes the key.
  const { key, source } = resolveSetKeyInput(argv, process.env, keyVar);
  if (!key) {
    throw new Error(
      `no api key: pass it after the provider (\`munin set-key ${provider} <key>\`), via --key <value>, ` +
        `or set ${keyVar} in your environment (the key is never printed)`,
    );
  }
  // A key on the command line lands in shell history — nudge toward the env var
  // (which doesn't), but proceed rather than refusing.
  if (source === 'positional' || source === 'flag') {
    console.error(
      `note: a key typed on the command line is saved in your shell history. To avoid that, export ${keyVar} and re-run \`munin set-key ${provider}\`.`,
    );
  }
  // `provider` is narrowed to 'anthropic' | 'openai' (= CloudProvider) by the guard above.
  const result = await runSetKey({ home, provider, key });
  console.log(formatSetKeySummary(result));
}

async function cmdMcpConnect(argv: readonly string[]): Promise<void> {
  const client = flagValue(argv, '--client');
  if (client !== 'claude-desktop' && client !== 'cursor') {
    throw new Error('munin mcp connect requires --client claude-desktop|cursor');
  }
  const home = resolveHome(argv);
  const name = flagValue(argv, '--name');
  const configPath = flagValue(argv, '--config-path');
  const project = flagValue(argv, '--project');
  const result = runConnect({
    client: client as McpClient,
    target: launchTarget,
    home,
    // The per-user default home (no env): when `home` is the default ~/.munin the
    // block omits MUNIN_HOME so it resolves per-user — a portable, relocatable block.
    defaultHome: resolveMuninHome({}),
    write: hasFlag(argv, '--write'),
    ...(name ? { name } : {}),
    ...(configPath ? { configPath } : {}),
    ...(project ? { project } : {}),
  });

  switch (result.action) {
    case 'printed':
      console.log(result.block);
      if (!result.pinned) console.error(UNPINNED_LAUNCHER_NOTE);
      console.log(`
Target: ${result.targetPath}
Paste the block above into your ${client} config, or re-run with --write to merge
it automatically (safe: backs up first, never clobbers other servers).`);
      console.error(portabilityNote(result.homeBaked, home, result.launchMode));
      break;
    case 'written':
      console.log(`✓ Wrote the \`munin\` MCP server to ${result.targetPath}`);
      if (result.backupPath) console.log(`  backed up the previous config to ${result.backupPath}`);
      console.log(`  Restart ${client} to pick it up, then run \`munin mcp doctor\`.`);
      console.error(portabilityNote(result.homeBaked, home, result.launchMode));
      break;
    case 'unchanged':
      console.log(`✓ ${result.targetPath} already has the \`munin\` server — no change.`);
      break;
    case 'refused':
      console.error(refusalMessage(result.targetPath, result.refusalReason));
      if (result.refusalReason !== 'unpinned-node') {
        console.error('Paste this block in by hand instead:\n');
        console.log(result.block);
      }
      process.exitCode = 1;
      break;
  }
}

// The note printed alongside an unpinned dry-run block, and the body of the
// unpinned-node --write refusal: a bare `pnpm` launcher lets the client re-resolve
// Node from PATH (an old nvm Node crashes the server mid-init — a "died
// mid-write" corruption trigger). Re-running under pnpm pins the exact Node + pnpm.
const UNPINNED_LAUNCHER_NOTE =
  '! This block uses a bare `pnpm` launcher (this command was not run under pnpm), which lets your\n' +
  '  AI client resolve Node from PATH — risking an old Node. Re-run via pnpm to pin an exact Node:\n' +
  '    pnpm --filter munin-mcp munin mcp connect …';

// The portability limitation printed after a connect (Stage B). The home pointer
// is made relocatable for a default home (MUNIN_HOME omitted → resolves per-user);
// the launcher's executable path + pinned Node remain machine-specific in BOTH
// forms — an installed `munin-mcp` bin path, or a repo `--dir` checkout path. So
// the honest guidance is: a default-home block is portable EXCEPT for the
// launcher, and any move to a different install/checkout/machine means re-running
// `munin mcp connect`.
function portabilityNote(
  homeBaked: boolean,
  home: string,
  launchMode: 'installed' | 'checkout',
): string {
  const lines = homeBaked
    ? [`! This block pins MUNIN_HOME=${home} (a non-default home) — machine-specific.`]
    : [
        '✓ This block omits MUNIN_HOME (your default ~/.munin), so the home pointer resolves',
        '  per-user on any machine — robust to moving the home.',
      ];
  if (launchMode === 'installed') {
    lines.push(
      "  The launcher points at the installed `munin-mcp` bin and pins this machine's Node —",
      '  both are machine-specific. After reinstalling elsewhere or on another machine,',
      '  re-run `munin mcp connect` to regenerate the block.',
    );
  } else {
    lines.push(
      '  The launcher still points at THIS checkout (the MCP server runs from the repo) and',
      "  pins this machine's Node — both are machine-specific. After moving to a different",
      '  checkout or machine, re-run `munin mcp connect` to regenerate the block.',
    );
  }
  return lines.join('\n');
}

function refusalMessage(targetPath: string, reason: RefusalReason | undefined): string {
  switch (reason) {
    case 'symlink':
      return `✗ Refusing to write: ${targetPath} is a symlink (we don't write through links).`;
    case 'unpinned-node':
      return `✗ Refusing to write an unpinned launcher.\n${UNPINNED_LAUNCHER_NOTE}`;
    default:
      return `✗ Refusing to write: ${targetPath} is not valid JSON (won't clobber it).`;
  }
}

async function cmdMcpDoctor(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  // Back-fill MUNIN_READ_AUDIT=false on an existing local home that predates the
  // read-audit-off posture, BEFORE doctor reads the file — so doctor reports the
  // migrated state. Safe while the AI client holds the store: this touches the
  // env file, not the pgdata. Idempotent and a no-op for a non-local home.
  applyLocalReadAuditMigration(muninHomeLayout(home).envPath, {
    log: (l) => console.log(l),
  });
  const report = await runDoctor({ home });
  console.log(renderDoctorReport(report.home, report.checks));
  if (!allChecksOk(report.checks)) process.exitCode = 1;
}

async function cmdSetup(argv: readonly string[]): Promise<void> {
  const home = resolveHome(argv);
  const clientFlag = flagValue(argv, '--client');
  if (clientFlag !== undefined && clientFlag !== 'claude-desktop' && clientFlag !== 'cursor') {
    throw new Error('munin setup --client must be claude-desktop or cursor');
  }
  const client: McpClient = (clientFlag as McpClient) ?? 'claude-desktop';
  const log = (l: string): void => console.log(l);
  const logError = (l: string): void => console.error(l);

  // Thin closures over the existing cores — the wizard orchestrates these and
  // re-implements none of them. Each reads process.env lazily, so the home env
  // loaded by initHome (below) is visible to the later steps.
  const actions: SetupActions = {
    initHome: async () => {
      const result = await runHomeInit({ home, log });
      // Back-fill MUNIN_READ_AUDIT=false on an existing home that predates the
      // read-audit-off posture (a fresh home already has it from the starter, so
      // this is a no-op there). Done BEFORE loadHomeIntoProcessEnv so the loaded
      // env — and the wizard's later extract step — see the non-writing posture.
      applyLocalReadAuditMigration(result.envPath, { log });
      // Make the munin.env visible to the ingest/extract/doctor steps (mirrors
      // cmdIngest/cmdExtract), so they are home-aware.
      loadHomeIntoProcessEnv(home);
      return result;
    },
    setKey: (provider, key) => runSetKey({ home, provider, key }),
    addFolder: async () => {
      // Capture the ingest summary so the wizard knows how many NEW documents
      // this run added (0 = every file was already in memory) and can gate the
      // optional extraction step. runAdd is still driven verbatim — it ignores
      // its `ingest` dep's return value, so this is a non-intrusive counting
      // shim around `runIngest`, not a change to runAdd or AddResult.
      let documentsAdded = 0;
      const result = await runAdd(appendIngestDefaults([], process.env), {
        pickFolder,
        ingest: async (argv) => {
          const summary = await runIngest(argv);
          documentsAdded = summary.ingested;
        },
        log,
        logError,
      });
      return { outcome: result.outcome, documentsAdded };
    },
    extract: async () => {
      const args: string[] = [];
      const tenant = process.env.MUNIN_TENANT_ID?.trim();
      if (tenant) args.push('--tenant', tenant);
      await runExtractCli(args);
    },
    connect: () => runConnect({ client, target: launchTarget, home, write: true }),
    doctor: () => runDoctor({ home }),
  };

  const result = await runSetup({
    env: process.env,
    client,
    prompts: createInteractivePrompts(),
    actions,
    log,
    logError,
  });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

// ---- dispatch -------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'setup':
      await cmdSetup(rest);
      return;
    case 'init':
      await cmdInit(rest);
      return;
    case 'ingest':
      await cmdIngest(rest);
      return;
    case 'add':
      await cmdAdd(rest);
      return;
    case 'extract':
      await cmdExtract(rest);
      return;
    case 'docs':
      await cmdDocs(rest);
      return;
    case 'forget':
      await cmdForget(rest);
      return;
    case 'status':
      await cmdStatus(rest);
      return;
    case 'set-key':
      await cmdSetKey(rest);
      return;
    case 'mcp': {
      const sub = rest[0];
      if (sub === 'connect') return cmdMcpConnect(rest.slice(1));
      if (sub === 'doctor') return cmdMcpDoctor(rest.slice(1));
      throw new Error(`unknown subcommand: munin mcp ${sub ?? '<none>'} (try \`munin --help\`)`);
    }
    default:
      throw new Error(`unknown command: munin ${cmd} (try \`munin --help\`)`);
  }
}

// Is this module the process entrypoint? Compare REAL paths so the guard still
// fires when `munin` is invoked through the `node_modules/.bin/munin` symlink
// (where process.argv[1] is the symlink, not this compiled file). A plain
// `import.meta.url === pathToFileURL(argv[1])` URL check passes only when run
// directly (e.g. `tsx src/munin-cli.ts`) and silently no-ops the installed bin.
function isProcessEntrypoint(invokedPath: string): boolean {
  try {
    return fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Direct entrypoint only — guarded so importing this module (e.g. unit tests of
// the arg helpers) does not run the dispatcher.
if (process.argv[1] && isProcessEntrypoint(process.argv[1])) {
  main().catch((err) => {
    if (err instanceof LocalInitRefusalError) {
      console.error(err.reportLines.join('\n'));
    } else if (err instanceof IngestDirectoryError) {
      // A bad ingest path carries its own product-framed guidance — print as-is.
      console.error(err.message);
    } else if (!reportLocalStoreError(err, { dataDir: process.env.PGLITE_DATA_DIR })) {
      // reportLocalStoreError handles the F71 locked/corrupt cases (friendly, no
      // stack); anything else falls through to the generic message.
      console.error(`munin: ${(err as Error).message ?? err}`);
    }
    process.exit(1);
  });
}

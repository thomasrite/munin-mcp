#!/usr/bin/env node
// munin-mcp — the runnable stdio entrypoint.
//
// Spawned as a child process by an MCP client (Claude Desktop, Cursor, the MCP
// inspector). stdout belongs ENTIRELY to the JSON-RPC transport; every log
// line goes to stderr via the pino logger. The OS process boundary is the
// trust boundary: no network listener, no auth of its own. Your machine, your
// keys, your choice of provider.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LocalStoreLockedError, LocalStoreUnavailableError } from '@muninhq/engine/graph-store';

import { hasUsableConfig, loadMuninHomeEnv } from './home-env';
import { logger } from './logger';
import { bootstrapRuntime } from './runtime';
import { buildServer } from './server';

// Config source is the per-user MUNIN_HOME (default ~/.munin), NOT the repo:
// load $MUNIN_HOME/munin.env (authoritative — override:true) and derive the
// data directories from the home. No repo root is assumed, so the server runs
// the same from any checkout or working directory.
const loadedHome = loadMuninHomeEnv();

async function main(): Promise<void> {
  // Fail fast, friendly, when there is no usable config — never crash deep in
  // bootstrap. Logs to stderr (stdout belongs to JSON-RPC).
  if (!hasUsableConfig(loadedHome)) {
    logger.error(
      { home: loadedHome.layout.home, envPath: loadedHome.layout.envPath },
      `No Munin home at ${loadedHome.layout.envPath} — run \`munin init\` to create one, then \`munin mcp connect\`.`,
    );
    process.exit(1);
  }

  const runtime = await bootstrapRuntime();
  logger.info(
    {
      home: loadedHome.layout.home,
      tenantId: runtime.tenantId,
      tenantSource: runtime.tenantSource,
      configuration: runtime.configuration.id,
      configurationVersion: runtime.configuration.version,
      accessTagCount: runtime.context.accessTags.length,
    },
    'munin-mcp runtime ready',
  );

  const server = buildServer(runtime);
  const transport = new StdioServerTransport();

  // Graceful shutdown: close the store (drains the read-audit buffer) before
  // exiting, on signals and on the client closing our stdin.
  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ reason }, 'munin-mcp shutting down');
    try {
      await server.close();
    } catch {
      // transport already gone — nothing to flush there
    }
    try {
      await runtime.close();
    } catch (err) {
      logger.error({ err }, 'store close failed during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('close', () => void shutdown('stdin closed'));

  await server.connect(transport);
  logger.info('munin-mcp listening on stdio');
}

main().catch((err) => {
  // F71: the local store being held by another process (e.g. a `munin ingest`
  // running while this MCP server starts) or being locked/corrupt is an expected
  // hazard of the local flow. Log a clean, actionable line to STDERR (stdout is
  // the JSON-RPC transport) instead of a raw WASM `Aborted()` stack.
  if (err instanceof LocalStoreLockedError) {
    logger.error(
      { home: loadedHome.layout.home, holderPid: err.holder?.pid },
      'munin-mcp cannot start: the local memory is in use by another process. Stop any running `munin ingest`/`extract` (only one Munin process can hold the local store), then restart this client.',
    );
  } else if (err instanceof LocalStoreUnavailableError) {
    logger.error({ home: loadedHome.layout.home }, `munin-mcp cannot start: ${err.message}`);
  } else {
    logger.error({ err }, 'munin-mcp failed to start');
  }
  process.exit(1);
});

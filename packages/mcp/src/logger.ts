// Stderr-only structured logging.
//
// PROTOCOL-CRITICAL: stdout belongs to the MCP JSON-RPC transport. One stray
// stdout write corrupts every connected client, so ALL logging in this package
// goes through this pino instance, which is pinned to file descriptor 2
// (stderr). No console.* anywhere in the package — enforced by
// no-stdout-guard.test.ts.

import pino from 'pino';

export const logger = pino(
  {
    name: 'munin-mcp',
    level: process.env.MUNIN_MCP_LOG_LEVEL?.trim() || 'info',
  },
  pino.destination(2),
);

export type Logger = typeof logger;

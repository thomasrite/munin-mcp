// The MCP server: five tools over the frozen engine surface, stdio transport.
//
// Tool descriptions are assembled from the LOADED CONFIGURATION's terminology
// map at registration time — this package contributes no vertical or persona
// words of its own. Tool failures become structured MCP tool errors with
// content-free messages; the full error goes to the stderr log only.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AuthError,
  ContextLengthError,
  ProviderConfigurationError,
  ProviderUnavailableError,
  RateLimitError,
} from '@muninhq/engine';
import { z } from 'zod';

import { buildServerInstructions } from './instructions';
import { logger } from './logger';
import { ask } from './tools/ask';
import { buildToolDescriptions } from './tools/descriptions';
import { gatherEntity } from './tools/gather-entity';
import { getDocument } from './tools/get-document';
import { retrieveContext } from './tools/retrieve-context';
import { status } from './tools/status';
import type { ToolDeps } from './tools/types';

const SERVER_NAME = 'munin-mcp';
const SERVER_VERSION = '0.0.0';

// Input shapes, exported for unit testing (the SDK validates calls against
// these before a handler ever runs — a bad input is rejected, never thrown).
export const TOOL_INPUT_SHAPES = {
  munin_retrieve_context: {
    question: z.string().min(1).describe('The question to retrieve context for.'),
    subject: z.string().min(1).optional().describe('Optional subject name to focus retrieval on.'),
  },
  munin_ask: {
    question: z.string().min(1).describe('The question to answer from the memory.'),
    subject: z
      .string()
      .min(1)
      .optional()
      .describe('Optional subject name to gather everything known about and answer over that set.'),
    pick: z
      .string()
      .min(1)
      .optional()
      .describe('A candidate pick token from a previous disambiguation result.'),
  },
  munin_gather_entity: {
    subject: z.string().min(1).describe('The subject name to gather records for.'),
    pick: z
      .string()
      .min(1)
      .optional()
      .describe('A candidate pick token from a previous disambiguation result.'),
  },
  munin_get_document: {
    documentId: z.string().min(1).describe('The document id (from a citation or source).'),
  },
  munin_status: {},
} as const;

// Content-free failure messages: name the failure class, never the internals
// (no stack, no SQL, no provider payloads — those go to the stderr log only).
export function toolErrorMessage(err: unknown): string {
  if (err instanceof RateLimitError)
    return 'The model provider rate-limited the request. Try again shortly.';
  if (err instanceof AuthError) return 'The model provider rejected the configured credentials.';
  if (err instanceof ProviderUnavailableError)
    return 'The model provider is unavailable. Try again shortly.';
  if (err instanceof ContextLengthError)
    return 'The request exceeded the model provider’s context window.';
  if (err instanceof ProviderConfigurationError)
    return 'The model provider is misconfigured. Check the server environment.';
  return 'The tool failed unexpectedly. Check the server log (stderr) for detail.';
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(tool: string, err: unknown): CallToolResult {
  logger.error({ tool, err }, 'tool call failed');
  return { content: [{ type: 'text', text: toolErrorMessage(err) }], isError: true };
}

export function buildServer(deps: ToolDeps): McpServer {
  const descriptions = buildToolDescriptions(deps.configuration);

  // Server-level instructions (sent in the `initialize` response) bias ANY client
  // toward this private memory and the grounding contract before it picks a tool.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildServerInstructions(deps.configuration) },
  );

  server.registerTool(
    'munin_retrieve_context',
    {
      description: descriptions.munin_retrieve_context,
      inputSchema: TOOL_INPUT_SHAPES.munin_retrieve_context,
    },
    async ({ question, subject }) => {
      try {
        return jsonResult(
          await retrieveContext(deps, { question, ...(subject !== undefined ? { subject } : {}) }),
        );
      } catch (err) {
        return errorResult('munin_retrieve_context', err);
      }
    },
  );

  server.registerTool(
    'munin_ask',
    {
      description: descriptions.munin_ask,
      inputSchema: TOOL_INPUT_SHAPES.munin_ask,
    },
    async ({ question, subject, pick }) => {
      try {
        return jsonResult(
          await ask(deps, {
            question,
            ...(subject !== undefined ? { subject } : {}),
            ...(pick !== undefined ? { pick } : {}),
          }),
        );
      } catch (err) {
        return errorResult('munin_ask', err);
      }
    },
  );

  server.registerTool(
    'munin_gather_entity',
    {
      description: descriptions.munin_gather_entity,
      inputSchema: TOOL_INPUT_SHAPES.munin_gather_entity,
    },
    async ({ subject, pick }) => {
      try {
        return jsonResult(
          await gatherEntity(deps, { subject, ...(pick !== undefined ? { pick } : {}) }),
        );
      } catch (err) {
        return errorResult('munin_gather_entity', err);
      }
    },
  );

  server.registerTool(
    'munin_get_document',
    {
      description: descriptions.munin_get_document,
      inputSchema: TOOL_INPUT_SHAPES.munin_get_document,
    },
    async ({ documentId }) => {
      try {
        return jsonResult(await getDocument(deps, { documentId }));
      } catch (err) {
        return errorResult('munin_get_document', err);
      }
    },
  );

  server.registerTool(
    'munin_status',
    {
      description: descriptions.munin_status,
      inputSchema: TOOL_INPUT_SHAPES.munin_status,
    },
    async () => {
      try {
        return jsonResult(await status(deps));
      } catch (err) {
        return errorResult('munin_status', err);
      }
    },
  );

  return server;
}

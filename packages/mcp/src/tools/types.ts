// What every tool handler receives. A structural subset of McpRuntime so the
// handlers are unit/integration-testable without the MCP SDK or a live server.

import type {
  ContextRetriever,
  GraphStoreReader,
  QueryPipeline,
  RegularReadContext,
  TenantId,
} from '@muninhq/engine';
import type { Configuration } from '@muninhq/shared';

export interface ToolDeps {
  readonly store: GraphStoreReader;
  readonly retriever: ContextRetriever;
  readonly pipeline: QueryPipeline;
  /** The single-user regular context — never a bypass (see context.ts). */
  readonly context: RegularReadContext;
  readonly configuration: Configuration;
  readonly tenantId: TenantId;
  readonly schemaHash: string;
}

// Runtime bootstrap: everything the five tools need, built once at startup.
//
// Wraps the FROZEN engine surface only — store via the loadGraphStore()
// factory (which carries the per-read audit decorator, MUNIN_READ_AUDIT
// default-on, and the future PGlite local option for free), providers via
// loadProvidersFromEnv(), configuration via loadConfigurationWithResolver
// resolved in THIS package's module context (the F20 discipline). Zero engine
// change; no internal-bypass token anywhere (see zero-bypass.test.ts).

import {
  ContextRetriever,
  QueryPipeline,
  type RegularReadContext,
  type TenantId,
  computeSchemaHash,
  loadConfigurationWithResolver,
  loadProvidersFromEnv,
} from '@muninhq/engine';
import { type GraphStoreHandle, loadGraphStore } from '@muninhq/engine/graph-store';
import type { Configuration } from '@muninhq/shared';

import { buildSingleUserContext } from './context';
import { queryOptionsFromConfig } from './query-defaults';
import { resolveTenant } from './tenant';

export interface McpRuntime {
  readonly store: GraphStoreHandle['store'];
  readonly configuration: Configuration;
  readonly tenantId: TenantId;
  readonly tenantSource: 'env' | 'discovered';
  readonly context: RegularReadContext;
  readonly retriever: ContextRetriever;
  readonly pipeline: QueryPipeline;
  /** Hash of the loaded configuration's extraction schema (pending-extraction signal). */
  readonly schemaHash: string;
  readonly close: () => Promise<void>;
}

function configPackageFromEnv(env: NodeJS.ProcessEnv): string {
  const pkg = env.MUNIN_CONFIG_PACKAGE?.trim();
  if (!pkg) {
    throw new Error(
      'MUNIN_CONFIG_PACKAGE is required (e.g. @muninhq/config-generic-demo). ' +
        'There is no default configuration — set it explicitly so terminology, tag expansion and retrieval defaults come from the right configuration.',
    );
  }
  return pkg;
}

export async function bootstrapRuntime(env: NodeJS.ProcessEnv = process.env): Promise<McpRuntime> {
  const configPackage = configPackageFromEnv(env);
  const handle = await loadGraphStore(env);
  try {
    // Resolve the configuration in THIS package's module context (F20): the
    // configuration package is @muninhq/mcp's dependency, not the engine's.
    const configuration = await loadConfigurationWithResolver(configPackage, (p) => import(p));
    const { tenantId, source } = await resolveTenant(handle, env);
    const context = await buildSingleUserContext(configuration, tenantId);
    const providers = loadProvidersFromEnv(env);
    const retrievalOptions = queryOptionsFromConfig(configuration);

    const retriever = new ContextRetriever({
      graphStore: handle.store,
      embeddingProvider: providers.embedding,
      ...(providers.rerank ? { rerankProvider: providers.rerank } : {}),
      ...retrievalOptions,
    });
    const pipeline = new QueryPipeline({
      graphStore: handle.store,
      llmProvider: providers.llm,
      embeddingProvider: providers.embedding,
      ...(providers.rerank ? { rerankProvider: providers.rerank } : {}),
      ...retrievalOptions,
    });

    return {
      store: handle.store,
      configuration,
      tenantId,
      tenantSource: source,
      context,
      retriever,
      pipeline,
      schemaHash: computeSchemaHash(configuration),
      close: handle.close,
    };
  } catch (err) {
    // Failed mid-bootstrap: release the store connection before rethrowing.
    await handle.close().catch(() => {});
    throw err;
  }
}

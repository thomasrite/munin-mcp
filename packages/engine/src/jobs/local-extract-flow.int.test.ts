// End-to-end inline-jobs flow (F44): ingest → inline embed → inline extract →
// permissioned read — the full local pipeline with NO worker process and NO
// cloud call (stub embedding + a scripted, content-aware LLM; £0).
//
// The SAME flow runs against BOTH backends (the migrations/stop-gate pattern):
//   - real Postgres via testcontainers — proving the inline leg is also valid
//     for tiny hosted corpora (JOBS=inline is store-agnostic);
//   - PGlite in-process — proving the fully-local store path.

import { computeSchemaHash } from '@muninhq/shared';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BlobStorage } from '../blob';
import type { Connector, ConnectorRecord } from '../connectors';
import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { EXTRACTION_TOOL_NAME } from '../extract/prompt-assembly';
import type { GraphStore } from '../graph/graph-store';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type ParagraphId,
  type ReadContext,
  type TenantId,
  asActorId,
  asTenantId,
  internalBypass,
} from '../graph/types';
import { IngestionPipeline } from '../ingest/ingestion-pipeline';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallContext,
  ProviderCapabilities,
} from '../providers';
import { StubEmbeddingProvider } from '../providers';
import { sampleConfiguration } from '../test-support/sample-configuration';
import { InlineExtractRunner } from './local-extract-runner';
import { InlineEmbedRunner } from './local-runner';

const ACTOR = asActorId('inline-flow-test');
const TAGS = ['team:ops'];

// Two-document synthetic generic corpus (Projects/People — no vertical
// concepts). Each document is one paragraph with a verbatim-extractable
// project name, so the scripted extractor can key off the text content.
const CORPUS = [
  {
    externalId: 'atlas.md',
    title: 'Atlas kickoff note',
    text: 'The Atlas project kicked off in March. Sarah Chen is responsible for delivery.',
  },
  {
    externalId: 'borealis.md',
    title: 'Borealis status note',
    text: 'The Borealis project remains in planning while the team finalises scope.',
  },
] as const;

class MemBlob implements BlobStorage {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(tenantId: TenantId, relativePath: string, bytes: Uint8Array): Promise<string> {
    const uri = `mem://${tenantId}/${relativePath}`;
    this.blobs.set(uri, bytes);
    return uri;
  }
  async get(uri: string): Promise<Uint8Array> {
    const b = this.blobs.get(uri);
    if (!b) throw new Error(`blob not found: ${uri}`);
    return b;
  }
  async exists(uri: string): Promise<boolean> {
    return this.blobs.has(uri);
  }
  async delete(uri: string): Promise<void> {
    this.blobs.delete(uri);
  }
  async ensureTenantContainer(): Promise<void> {}
}

function corpusConnector(): Connector {
  return {
    packageName: '@muninhq/connector-test',
    humanName: 'test corpus',
    async *list(): AsyncIterable<ConnectorRecord> {
      for (const doc of CORPUS) {
        yield {
          kind: 'document',
          document: {
            externalId: doc.externalId,
            title: doc.title,
            mimeType: 'text/markdown',
            fetchBytes: async () => new TextEncoder().encode(doc.text),
          },
        };
      }
    },
  };
}

// Content-aware scripted LLM: extracts the project named in the paragraph it
// is shown — order-independent, so the test does not depend on which pending
// paragraph the discovery query returns first.
class ContentAwareLlmProvider implements LLMProvider {
  readonly id = 'scripted-content';
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 200_000,
    maxBatchSize: 1,
  };
  readonly defaultModel = 'scripted-model';
  callCount = 0;

  async complete(request: LLMRequest, _ctx: ProviderCallContext): Promise<LLMResponse> {
    this.callCount++;
    const text = request.messages.map((m) => m.content).join('\n');
    const tool = (input: Record<string, unknown>): LLMResponse => ({
      text: '',
      toolCalls: [{ id: 'tc-0', name: EXTRACTION_TOOL_NAME, input }],
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      modelId: this.defaultModel,
      stopReason: 'tool_use',
    });
    if (text.includes('Atlas')) {
      return tool({
        entities: [
          { type: 'Project', properties: { name: 'Atlas' } },
          { type: 'Person', properties: { fullName: 'Sarah Chen' } },
        ],
        relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
      });
    }
    if (text.includes('Borealis')) {
      return tool({
        entities: [{ type: 'Project', properties: { name: 'Borealis', status: 'planning' } }],
        relationships: [],
      });
    }
    return tool({ entities: [], relationships: [] });
  }
}

// The shared flow, identical for both backends.
async function runFlow(store: GraphStore, tenantId: TenantId): Promise<void> {
  const regular: ReadContext = { kind: 'regular', tenantId, accessTags: TAGS, actor: ACTOR };
  // Pending-paragraph discovery mirrors extract-cli's allowlisted maintenance
  // read (no new bypass site — this is a test-context read, inventoried by
  // the bypass-inventory test as test usage).
  const maintenance: ReadContext = {
    kind: 'bypass',
    tenantId,
    bypass: internalBypass('inline-flow-test', 'discover pending paragraphs for the test flow'),
    actor: ACTOR,
  };

  // 1. Ingest with INLINE embedding — no worker.
  const embedProvider = new StubEmbeddingProvider();
  const pipeline = new IngestionPipeline({
    graphStore: store,
    blobStorage: new MemBlob(),
    embeddingModelId: embedProvider.modelId,
    embedEnqueuer: new InlineEmbedRunner({ graphStore: store, embeddingProvider: embedProvider }),
  });
  const summary = await pipeline.ingest({
    tenantId,
    connector: corpusConnector(),
    connectorConfig: {},
    accessTags: TAGS,
  });
  expect(summary.ingested).toBe(2);

  // Embeddings landed inline: the paragraphs are vector-searchable already.
  const hits = await store.searchByVector(regular, {
    modelId: embedProvider.modelId,
    k: 5,
    queryVector: new Array(1024).fill(0.1),
  });
  expect(hits.length).toBeGreaterThanOrEqual(2);

  // 2. Discover pending paragraphs (the extract-cli leg), then extract INLINE.
  const schemaHash = computeSchemaHash(sampleConfiguration);
  const pending = await store.findParagraphsPendingExtraction(maintenance, { schemaHash });
  expect(pending.length).toBeGreaterThanOrEqual(2);

  const llm = new ContentAwareLlmProvider();
  const runner = new InlineExtractRunner({
    graphStore: store,
    llmProvider: llm,
    configuration: sampleConfiguration,
  });
  const result = await runner.run([
    { tenantId, paragraphIds: pending.map((p) => p.id as ParagraphId) },
  ]);
  expect(result.errors).toEqual([]);
  expect(result.extracted).toBeGreaterThanOrEqual(2);
  expect(result.entitiesWritten).toBeGreaterThanOrEqual(3);
  expect(result.edgesWritten).toBeGreaterThanOrEqual(1);

  // 3. The graph is visible to a REGULAR permissioned read — the query layer's
  //    entry points, no bypass.
  const projects = await store.findEntities(regular, { types: ['Project'], limit: 10 });
  const names = projects.items.map((e) => e.properties.name).sort();
  expect(names).toEqual(['Atlas', 'Borealis']);
  for (const entity of projects.items) {
    expect(entity.provenance.kind).toBe('document_extract');
    if (entity.provenance.kind === 'document_extract') {
      expect(entity.provenance.paragraphId).toBeTruthy();
      expect(entity.provenance.extractorVersionId).toBeTruthy();
      // Names appear verbatim in the source paragraphs.
      expect(entity.provenance.confidence).toBe(1);
    }
  }

  // The gather/graph-expansion read (retrieved paragraphs → their entities)
  // sees the extraction output too.
  const byParagraph = await store.findEntitiesByParagraphIds(
    regular,
    pending.map((p) => p.id as ParagraphId),
  );
  expect(byParagraph.length).toBeGreaterThanOrEqual(3);

  // And nothing extracted leaks to a caller without the tags (fail-closed).
  const untagged: ReadContext = { kind: 'regular', tenantId, accessTags: [], actor: ACTOR };
  const invisible = await store.findEntities(untagged, { types: ['Project'], limit: 10 });
  expect(invisible.items).toEqual([]);
}

describe('inline ingest → embed → extract → read (real Postgres, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let store: PostgresGraphStore;
  const TENANT = asTenantId('00000000-0000-0000-0000-0000000f4401');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
    await runMigrations(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 5 });
    const db = drizzle(client);
    store = new PostgresGraphStore(db);
    await db.insert(tenants).values({ id: TENANT, name: 'inline-flow-pg' });
  }, 180_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    if (container) await container.stop();
  });

  it('runs the full inline flow with zero worker jobs and zero cloud calls', async () => {
    await runFlow(store, TENANT);
  });
});

describe('inline ingest → embed → extract → read (PGlite, in-process)', () => {
  let handle: PgliteGraphStoreHandle;
  const TENANT = asTenantId('00000000-0000-0000-0000-0000000f4402');

  beforeAll(async () => {
    handle = await createPgliteGraphStore({}); // in-memory PGlite
    await handle.db.insert(tenants).values({ id: TENANT, name: 'inline-flow-pglite' });
  }, 60_000);

  afterAll(async () => {
    await handle?.close();
  });

  it('runs the SAME flow on the local store — the fully-local pipeline is complete', async () => {
    await runFlow(handle.store, TENANT);
  });
});

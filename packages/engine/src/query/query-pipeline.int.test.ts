// Integration tests for QueryPipeline against a real Postgres (testcontainers).
//
// Providers are stubbed (no real API spend, deterministic): the embedding stub
// returns a fixed query vector; the LLM stub returns a scripted tool call and
// counts its invocations. The graph, embeddings, and every permission filter
// are real. Coverage:
//   - an answer cites ≥1 visible paragraph;
//   - a caller missing the required tag sees no protected paragraph or citation
//     anywhere along retrieval + expansion;
//   - a no-evidence question short-circuits with zero LLM calls;
//   - a fabricated citation marker is rejected.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { queryEvents, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type EntityId,
  type ExtractorVersionId,
  type ParagraphId,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asExtractorVersionId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  ProviderCapabilities,
} from '../providers';
import { ANSWER_TOOL_NAME } from './answer-prompt';
import { QueryPipeline } from './query-pipeline';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-00000000aaaa');
const ACTOR = asActorId('test-actor');
const MODEL = 'test-embed-model';

let doc: DocumentId;
let publicPara: ParagraphId;
let restrictedPara: ParagraphId;
let ext: ExtractorVersionId;
let publicEntity: EntityId;
let restrictedEntity: EntityId;

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

// Deterministic unit-norm 1024-D vector from a seed (mirrors the graph-store
// int-test helper). Distinct seeds → near-orthogonal vectors.
function fakeVector(seed: number, dims = 1024): number[] {
  const v: number[] = [];
  let state = seed * 2654435761;
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const x = (state / 0x7fffffff) * 2 - 1;
    v.push(x);
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

const PUBLIC_VEC = fakeVector(1);
const RESTRICTED_VEC = fakeVector(2);

// Embedding stub: always returns the supplied fixed query vector.
function embeddingStub(queryVector: readonly number[]): EmbeddingProvider {
  return {
    id: 'stub-embed',
    capabilities: CAPS,
    dimensions: 1024,
    modelId: MODEL,
    async embed(_req: EmbedRequest): Promise<EmbedResponse> {
      return { vectors: [queryVector], inputTokens: 1, modelId: MODEL };
    },
  };
}

// LLM stub: returns scripted tool calls and counts calls.
function llmStub(toolCalls: readonly LLMToolCall[]): {
  provider: LLMProvider;
  calls: () => number;
} {
  let count = 0;
  const provider: LLMProvider = {
    id: 'stub-llm',
    capabilities: CAPS,
    defaultModel: 'claude-opus-4-7',
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      count += 1;
      return {
        text: '',
        toolCalls,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        modelId: 'claude-opus-4-7',
        stopReason: 'tool_use',
      };
    },
  };
  return { provider, calls: () => count };
}

function answerCall(
  citations: ReadonlyArray<{ marker: number; sourceId: string; quote: string }>,
): LLMToolCall {
  return {
    id: 't1',
    name: ANSWER_TOOL_NAME,
    input: { status: 'answered', answer: 'Answer text [1].', citations },
  };
}

const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values([{ id: TENANT, name: 'Tenant' }]);
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents,
    extractor_versions, audit_events, llm_calls, connector_state RESTART IDENTITY CASCADE`);

  doc = asDocumentId(crypto.randomUUID());
  publicPara = asParagraphId(crypto.randomUUID());
  restrictedPara = asParagraphId(crypto.randomUUID());
  ext = asExtractorVersionId(crypto.randomUUID());

  const ctx = writeCtx(TENANT);
  await store.insertDocument(ctx, {
    id: doc,
    title: 'Demo Doc',
    blobStorageUri: 'blob://demo',
    accessTags: ['t:public'],
  });
  await store.insertParagraphsBulk(ctx, [
    {
      id: publicPara,
      documentId: doc,
      paragraphIndex: 0,
      text: 'The Apollo project ships in Q3.',
      accessTags: ['t:public'],
    },
    {
      id: restrictedPara,
      documentId: doc,
      paragraphIndex: 1,
      text: 'SECRET restricted budget figure.',
      accessTags: ['t:restricted'],
    },
  ]);
  await store.upsertExtractorVersion(ctx, {
    id: ext,
    configurationId: 'test-cfg',
    configurationVersion: '0.1.0',
    schemaHash: 'h',
    promptHash: 'p',
    modelId: MODEL,
  });

  // One entity per paragraph, with an edge between them so a public-only
  // caller's expansion from the public entity reaches the restricted entity —
  // which must be filtered out.
  const pe = await store.insertEntity(ctx, {
    type: 'Project',
    properties: { name: 'Apollo' },
    accessTags: ['t:public'],
    provenance: {
      kind: 'document_extract',
      documentId: doc,
      paragraphId: publicPara,
      extractorVersionId: ext,
      confidence: 1,
    },
  });
  publicEntity = pe.id;
  const re = await store.insertEntity(ctx, {
    type: 'Budget',
    properties: { name: 'Secret' },
    accessTags: ['t:restricted'],
    provenance: {
      kind: 'document_extract',
      documentId: doc,
      paragraphId: restrictedPara,
      extractorVersionId: ext,
      confidence: 1,
    },
  });
  restrictedEntity = re.id;
  await store.insertEdge(ctx, {
    type: 'relates_to',
    fromEntityId: publicEntity,
    toEntityId: restrictedEntity,
    accessTags: ['t:public'],
    provenance: {
      kind: 'document_extract',
      documentId: doc,
      paragraphId: publicPara,
      extractorVersionId: ext,
      confidence: 1,
    },
  });

  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: publicPara,
    modelId: MODEL,
    vector: PUBLIC_VEC,
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: restrictedPara,
    modelId: MODEL,
    vector: RESTRICTED_VEC,
  });
});

describe('QueryPipeline', () => {
  it('answers with a citation resolving to a visible paragraph', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider, calls } = llmStub([
      answerCall([{ marker: 1, sourceId: 'P1', quote: 'Apollo project ships in Q3' }]),
    ]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'When does Apollo ship?',
    });

    expect(calls()).toBe(1);
    expect(result.status).toBe('answered');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.paragraphId).toBe(publicPara);
    expect(result.citations[0]!.documentId).toBe(doc);
  });

  it('writes a query_events telemetry row for every answer (D2)', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([
      answerCall([{ marker: 1, sourceId: 'P1', quote: 'Apollo project ships in Q3' }]),
    ]);
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });

    await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'When does Apollo ship?',
      actor: asActorId('test:qe'),
    });

    const rows = await db
      .select()
      .from(queryEvents)
      .where(and(eq(queryEvents.tenantId, TENANT), eq(queryEvents.actor, 'test:qe')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('answered');
    expect(rows[0]!.resultCount).toBe(1);
  });

  it('never exposes a restricted paragraph through retrieval or expansion', async () => {
    // The model maliciously cites P2 (which would be the restricted para if it
    // were visible) plus a valid P1.
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([
      answerCall([
        { marker: 1, sourceId: 'P1', quote: 'Apollo' },
        { marker: 2, sourceId: 'P2', quote: 'restricted budget' },
      ]),
    ]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'budget?',
    });

    // Only the public paragraph is ever a valid source; the restricted one is
    // filtered before the prompt, so P2 cannot resolve.
    expect(result.citations.every((c) => c.paragraphId !== restrictedPara)).toBe(true);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.paragraphId).toBe(publicPara);
  });

  it('returns no_evidence and makes no LLM call when nothing is visible', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider, calls } = llmStub([answerCall([{ marker: 1, sourceId: 'P1', quote: 'x' }])]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    // Empty tag set → caller sees nothing → grounding empty → short-circuit.
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: [],
      question: 'anything?',
    });

    expect(calls()).toBe(0);
    expect(result.status).toBe('no_evidence');
    expect(result.citations).toHaveLength(0);
  });

  it('records a no_evidence query_events row, and an error row when the query throws (D2)', async () => {
    // no_evidence outcome → row with status no_evidence, resultCount 0.
    const okEmbed = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([answerCall([])]);
    const okPipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: okEmbed,
    });
    await okPipeline.answer({
      tenantId: TENANT,
      accessTags: [],
      question: 'q?',
      actor: asActorId('test:ne'),
    });
    const ne = await db
      .select()
      .from(queryEvents)
      .where(and(eq(queryEvents.tenantId, TENANT), eq(queryEvents.actor, 'test:ne')));
    expect(ne).toHaveLength(1);
    expect(ne[0]!.status).toBe('no_evidence');

    // A throwing provider → answer() rejects, but an 'error' row is still written.
    const throwingEmbed: EmbeddingProvider = {
      id: 'boom',
      capabilities: okEmbed.capabilities,
      dimensions: okEmbed.dimensions,
      modelId: okEmbed.modelId,
      embed: () => Promise.reject(new Error('provider down')),
    };
    const badPipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: throwingEmbed,
    });
    await expect(
      badPipeline.answer({
        tenantId: TENANT,
        accessTags: ['t:public'],
        question: 'q?',
        actor: asActorId('test:err'),
      }),
    ).rejects.toThrow('provider down');
    const er = await db
      .select()
      .from(queryEvents)
      .where(and(eq(queryEvents.tenantId, TENANT), eq(queryEvents.actor, 'test:err')));
    expect(er).toHaveLength(1);
    expect(er[0]!.status).toBe('error');
    expect(er[0]!.resultCount).toBe(0);
  });

  it('drops a citation whose quote is fabricated even when the source id is real', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([
      answerCall([{ marker: 1, sourceId: 'P1', quote: 'the budget was cut by forty percent' }]),
    ]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'q?',
    });

    // P1 is real and visible, but the quote is not in the paragraph → dropped →
    // no surviving citation → no_evidence.
    expect(result.status).toBe('no_evidence');
    expect(result.citations).toHaveLength(0);
  });

  it('downgrades an "answered" result with a blank answer to no_evidence', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([
      {
        id: 't1',
        name: ANSWER_TOOL_NAME,
        input: {
          status: 'answered',
          answer: '   ',
          citations: [{ marker: 1, sourceId: 'P1', quote: 'x' }],
        },
      },
    ]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'q?',
    });

    expect(result.status).toBe('no_evidence');
    expect(result.citations).toHaveLength(0);
  });

  it('deduplicates citations that share a marker, keeping the first', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([
      answerCall([
        { marker: 1, sourceId: 'P1', quote: 'Apollo project' },
        { marker: 1, sourceId: 'P1', quote: 'ships in Q3' },
      ]),
    ]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'q?',
    });

    expect(result.status).toBe('answered');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.quote).toBe('Apollo project');
  });

  it('rejects a fabricated citation marker not in the grounding set', async () => {
    const embedding = embeddingStub(PUBLIC_VEC);
    const { provider } = llmStub([
      answerCall([
        { marker: 1, sourceId: 'P1', quote: 'Apollo' },
        { marker: 2, sourceId: 'P99', quote: 'made up' },
      ]),
    ]);

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: provider,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'q?',
    });

    expect(result.status).toBe('answered');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.marker).toBe(1);
  });
});

// Query-pipeline end-to-end no-leak — P0, default suite, stub providers.
//
// The permission matrix proves each GraphStore read filters correctly. This
// proves the COMPOSITION: a low-clearance caller's grounded answer never cites
// or quotes a restricted paragraph, even when a restricted entity is one
// expansion hop from a visible one (the 1.7a paragraphs → findEntitiesByParagraphIds
// → getNeighbours → contributing-paragraphs path). Deterministic stub providers:
// a constant-vector embedding (so retrieval returns whatever the access filter
// permits) and a stub LLM that echoes a grounded quote from the first source —
// so if any restricted source ever reached the prompt, the answer would surface
// it and the test would catch it.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { EXTRACTION_TOOL_NAME } from '../extract';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type EntityId,
  type ExtractorVersionId,
  type ParagraphId,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
} from '../graph/types';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallContext,
  ProviderCapabilities,
} from '../providers';
import { ANSWER_TOOL_NAME } from '../query';
import { QueryPipeline } from '../query/query-pipeline';

const TENANT = asTenantId('00000000-0000-0000-0000-00000000eeee');
const ACTOR = asActorId('query-leak');
const MODEL = 'leak-model';
const SECRET_CANARY = 'ninety thousand pounds';

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};
const constantVector = new Array<number>(1024).fill(1 / Math.sqrt(1024));

async function recordCall(
  ctx: ProviderCallContext,
  modelId: string,
  purpose: ProviderCallContext['purpose'],
): Promise<void> {
  await ctx.graphStore.insertLlmCall(
    { tenantId: ctx.tenantId, actor: asActorId('stub') },
    {
      purpose,
      modelId,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      latencyMs: 1,
      region: 'stub',
    },
  );
}

const embeddingStub: EmbeddingProvider = {
  id: 'stub-embed',
  capabilities: CAPS,
  dimensions: 1024,
  modelId: MODEL,
  async embed(req: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse> {
    await recordCall(ctx, MODEL, 'embedding');
    return { vectors: req.texts.map(() => constantVector), inputTokens: 1, modelId: MODEL };
  },
};

function firstSourceQuote(message: string): { sourceId: string; quote: string } | null {
  const m = message.match(/<source id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/source>/);
  if (!m) return null;
  return { sourceId: m[1]!, quote: m[2]!.trim().split(/\s+/).slice(0, 6).join(' ') };
}

const llmStub: LLMProvider = {
  id: 'stub-llm',
  capabilities: CAPS,
  defaultModel: 'stub-model',
  async complete(req: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    await recordCall(ctx, 'stub-model', ctx.purpose);
    const tool = req.toolChoice?.name;
    if (tool === EXTRACTION_TOOL_NAME) {
      return toolResp(EXTRACTION_TOOL_NAME, { entities: [], relationships: [] });
    }
    if (tool === ANSWER_TOOL_NAME) {
      const src = firstSourceQuote(req.messages.map((m) => m.content).join('\n'));
      if (!src)
        return toolResp(ANSWER_TOOL_NAME, { status: 'no_evidence', answer: 'none', citations: [] });
      return toolResp(ANSWER_TOOL_NAME, {
        status: 'answered',
        answer: 'Answer [1].',
        citations: [{ marker: 1, sourceId: src.sourceId, quote: src.quote }],
      });
    }
    return toolResp('', {});
  },
};

function toolResp(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    text: '',
    toolCalls: name ? [{ id: 't1', name, input }] : [],
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    modelId: 'stub-model',
    stopReason: 'tool_use',
  };
}

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
const writeCtx = (t: TenantId): WriteContext => ({ tenantId: t, actor: ACTOR });

let docSecret: DocumentId;
let paraSecret: ParagraphId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'leak' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents, embeddings,
    extractor_versions, audit_events, llm_calls, connector_state RESTART IDENTITY CASCADE`);

  const ctx = writeCtx(TENANT);
  const docPub = (
    await store.insertDocument(ctx, {
      title: 'public.md',
      blobStorageUri: 'b://p',
      accessTags: ['t:pub'],
    })
  ).id;
  docSecret = (
    await store.insertDocument(ctx, {
      title: 'secret.md',
      blobStorageUri: 'b://s',
      accessTags: ['t:secret'],
    })
  ).id;
  const paraPub = (
    await store.insertParagraphsBulk(ctx, [
      {
        documentId: docPub,
        paragraphIndex: 0,
        text: 'Project Apollo ships in the third quarter.',
        accessTags: ['t:pub'],
      },
    ])
  )[0]!.id;
  paraSecret = (
    await store.insertParagraphsBulk(ctx, [
      {
        documentId: docSecret,
        paragraphIndex: 0,
        text: `The Apollo budget is ${SECRET_CANARY}.`,
        accessTags: ['t:secret'],
      },
    ])
  )[0]!.id;
  const ext = (
    await store.upsertExtractorVersion(ctx, {
      configurationId: 'cfg',
      configurationVersion: '0.1.0',
      schemaHash: 'h',
      promptHash: 'p',
      modelId: MODEL,
    })
  ).id as ExtractorVersionId;

  const prov = (para: ParagraphId, doc: DocumentId) => ({
    kind: 'document_extract' as const,
    documentId: doc,
    paragraphId: para,
    extractorVersionId: ext,
    confidence: 1,
  });
  const pubEntity: EntityId = (
    await store.insertEntity(ctx, {
      type: 'Project',
      properties: { name: 'Apollo' },
      accessTags: ['t:pub'],
      provenance: prov(paraPub, docPub),
    })
  ).id;
  const secretEntity: EntityId = (
    await store.insertEntity(ctx, {
      type: 'Budget',
      properties: { name: 'Apollo budget' },
      accessTags: ['t:secret'],
      provenance: prov(paraSecret, docSecret),
    })
  ).id;
  // Edge pub→secret (pub-tagged) so a pub caller's expansion REACHES the secret
  // entity — the triple-filter must still drop it.
  await store.insertEdge(ctx, {
    type: 'relates_to',
    fromEntityId: pubEntity,
    toEntityId: secretEntity,
    accessTags: ['t:pub'],
    provenance: prov(paraPub, docPub),
  });

  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: paraPub,
    modelId: MODEL,
    vector: constantVector,
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: paraSecret,
    modelId: MODEL,
    vector: constantVector,
  });
});

describe('query pipeline — no restricted leak (P0)', () => {
  it('a public caller never cites or quotes restricted content, even via expansion', async () => {
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: llmStub,
      embeddingProvider: embeddingStub,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:pub'],
      question: 'What about the Apollo budget?',
    });

    // No citation resolves to the restricted document/paragraph.
    expect(result.citations.every((c) => c.documentId !== docSecret)).toBe(true);
    expect(result.citations.every((c) => c.paragraphId !== paraSecret)).toBe(true);
    // The restricted canary string never appears in the answer.
    expect(result.answer).not.toContain(SECRET_CANARY);
  });

  it('a secret-clearance caller CAN reach the restricted content (proves the test is not vacuous)', async () => {
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: llmStub,
      embeddingProvider: embeddingStub,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:secret'],
      question: 'What about the Apollo budget?',
    });
    // With clearance, the restricted paragraph is retrievable and citable.
    expect(result.status).toBe('answered');
    expect(result.citations.some((c) => c.paragraphId === paraSecret)).toBe(true);
  });
});

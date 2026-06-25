// Completeness-banner truncation guard (audit finding #1) — end-to-end against
// Postgres + the real M1.2 gather, no answer model required (a deterministic stub
// LLM cites a seeded quote). This is the faithful, £0 proof of the CONFIRMED-HIGH
// defect: a subject with MORE linked records than the grounding window admits can
// be answered "complete" while the model only ever saw the first `maxParagraphs`.
//
// Scenario: one person "Helena Voss", 20 records, ALL key-bearing (same
// employeeRef) → the gather is complete BY CONSTRUCTION (mayHaveUnlinkedRecords =
// false), so the ONLY thing that can make the answer incomplete is the grounding
// window truncating the gathered set. Pre-fix the banner claims complete:true;
// post-fix it reports complete:false and names "12 of 20".

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EntityResolutionHints } from '@muninhq/shared';
import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type ExtractorVersionId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
} from '../graph/types';
import type { EmbeddingProvider, LLMProvider, LLMRequest, LLMResponse } from '../providers';
import { ANSWER_TOOL_NAME } from './answer-prompt';
import { ContextRetriever } from './context-retriever';
import { QueryPipeline } from './query-pipeline';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000c1');
const ACTOR = asActorId('completeness-truncation');
const TAGS = ['t:all'];
// Default grounding window: maxParagraphs = 12 (query-pipeline / context-retriever).
const DEFAULT_MAX_PARAGRAPHS = 12;
const RECORD_COUNT = 20; // > DEFAULT_MAX_PARAGRAPHS so the window must truncate.
const HINTS = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['employeeRef'] }],
]);

const readCtx = (): ReadContext => ({
  kind: 'regular',
  tenantId: TENANT,
  accessTags: TAGS,
  actor: ACTOR,
});
const writeCtx = (): WriteContext => ({ tenantId: TENANT, actor: ACTOR });

let ext: ExtractorVersionId;

// Insert one record: a document + paragraph + an Employee entity, all carrying the
// same exact key (employeeRef) so the gather is key-complete (no unlinked remainder).
async function insertRecord(index: number): Promise<void> {
  const ctx = writeCtx();
  const doc = (
    await store.insertDocument(ctx, {
      title: `helena-voss-${index}`,
      blobStorageUri: `b://helena/${index}`,
      sha256: `sha-helena-${index}`,
      accessTags: TAGS,
    })
  ).id;
  const para = (
    await store.insertParagraphsBulk(ctx, [
      {
        documentId: doc,
        paragraphIndex: 0,
        text: `Record ${index} concerning Helena Voss.`,
        accessTags: TAGS,
      },
    ])
  )[0]!.id;
  await store.insertEntity(ctx, {
    type: 'Employee',
    properties: { fullName: 'Helena Voss', employeeRef: 'EMP-001' },
    accessTags: TAGS,
    provenance: {
      kind: 'document_extract' as const,
      documentId: doc,
      paragraphId: para,
      extractorVersionId: ext,
      confidence: 1,
    },
  });
}

// Deterministic stub LLM: answers, citing source P1 with a verbatim quote that
// appears in every seeded paragraph (so the citation grounds and survives resolve()).
const citingLLM: LLMProvider = {
  id: 'stub',
  capabilities: {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 100000,
    maxBatchSize: 1,
  },
  defaultModel: 'claude-opus-4-7',
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    return {
      text: '',
      toolCalls: [
        {
          id: 't1',
          name: ANSWER_TOOL_NAME,
          input: {
            status: 'answered',
            answer: 'Here is what is on file [1].',
            citations: [{ marker: 1, sourceId: 'P1', quote: 'Helena Voss' }],
          },
        },
      ],
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      modelId: 'claude-opus-4-7',
      stopReason: 'tool_use',
    };
  },
};

// The gather path never embeds (it is key-led), but both ContextRetriever and
// QueryPipeline require an embedding provider — a stub suffices.
const embedding = {
  id: 'stub-embed',
  modelId: 'stub-embed',
  dimensions: 1,
  capabilities: {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 1,
    maxBatchSize: 1,
  },
  async embed() {
    return { vectors: [[0]], modelId: 'stub-embed' };
  },
} as unknown as EmbeddingProvider;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  client = postgres(container.getConnectionUri(), { max: 4 });
  await runMigrations(container.getConnectionUri());
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'completeness-truncation' });
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE entities, paragraphs, documents, extractor_versions RESTART IDENTITY CASCADE`,
  );
  ext = (
    await store.upsertExtractorVersion(writeCtx(), {
      configurationId: 'c',
      configurationVersion: '0.1.0',
      schemaHash: 'h',
      promptHash: 'p',
      modelId: 'm',
    })
  ).id;
});

describe('completeness banner must not claim complete when grounding truncated the gathered set', () => {
  it('20 key-linked records, 12-paragraph window → answered with complete:false naming 12-of-20', async () => {
    for (let i = 1; i <= RECORD_COUNT; i++) await insertRecord(i);

    // Real gather via the identity layer (exactly the web ask path: retrieveContext
    // → answerFromContext). No maxParagraphs override → the default 12-wide window.
    const retriever = new ContextRetriever({ graphStore: store, embeddingProvider: embedding });
    const context = await retriever.retrieveContext(readCtx(), {
      question: 'Everything about Helena Voss',
      identity: { subjectTypes: ['Employee'], hintsByType: HINTS },
    });

    // Sanity: the gather found all 20 (key-complete), but the window admitted only 12.
    expect(context.kind).toBe('context');
    if (context.kind !== 'context') throw new Error('expected the gather context arm');
    expect(context.completeness?.recordCount).toBe(RECORD_COUNT);
    expect(context.completeness?.mayHaveUnlinkedRecords).toBe(false);
    expect(context.sources.length).toBe(DEFAULT_MAX_PARAGRAPHS); // truncated to the window

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: citingLLM,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answerFromContext({ tenantId: TENANT, actor: ACTOR }, context);

    // THE DEFECT: pre-fix this is complete:true despite the model seeing only 12 of 20.
    expect(result.status).toBe('answered');
    expect(result.completeness).toBeDefined();
    expect(result.completeness?.complete).toBe(false);
    expect(result.completeness?.recordCount).toBe(RECORD_COUNT);
    expect(result.completeness?.note).not.toBeNull();
    expect(result.completeness?.note).toContain('Helena Voss');
    expect(result.completeness?.note).toContain(String(DEFAULT_MAX_PARAGRAPHS)); // 12 admitted
    expect(result.completeness?.note).toContain(String(RECORD_COUNT)); // of 20 gathered
  });
});

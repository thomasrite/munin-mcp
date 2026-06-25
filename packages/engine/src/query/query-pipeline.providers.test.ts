// Query pipeline end-to-end against real Anthropic + OpenAI.
//
// Gated behind `pnpm test:providers` (default `pnpm test` excludes
// `*.providers.test.ts`) and skipped unless BOTH keys are present — the loop
// embeds with OpenAI and synthesises with Anthropic. This is the first session
// where the full query loop runs against real models, so we verify the
// structured answer parses and the citation resolves to the seeded paragraph.
// Spend: a few pence per run. Asserts structural behaviour, not answer content.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type ParagraphId,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asExtractorVersionId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import {
  AnthropicLLMProvider,
  OpenAIEmbeddingProvider,
  type ProviderCallContext,
} from '../providers';
import { QueryPipeline } from './query-pipeline';

const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();
const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
const enabled = hasAnthropic && hasOpenAI;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-000000000077');
const ACTOR = asActorId('query-providers-test');

const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

beforeAll(async () => {
  if (!enabled) return;
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'query-providers-test' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

describe.skipIf(!enabled)('QueryPipeline — real Anthropic + OpenAI end-to-end', () => {
  const embedding = new OpenAIEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    modelId: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    dimensions: 1024,
  });
  // Sonnet is plenty for this structural check; avoid the Opus default to keep
  // the contract-test spend low.
  const llm = new AnthropicLLMProvider({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    defaultModel: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
  });

  it('embeds, retrieves, grounds and returns a citation resolving to the seeded paragraph', async () => {
    const ctx = writeCtx(TENANT);
    const doc: DocumentId = asDocumentId(crypto.randomUUID());
    const para: ParagraphId = asParagraphId(crypto.randomUUID());
    const ext = asExtractorVersionId(crypto.randomUUID());

    await store.insertDocument(ctx, {
      id: doc,
      title: 'Project Brief',
      blobStorageUri: 'blob://brief',
      accessTags: ['t:public'],
    });
    const text =
      'The Apollo project is led by Sarah Jones and is scheduled to ship in the third quarter of 2026.';
    await store.insertParagraphsBulk(ctx, [
      { id: para, documentId: doc, paragraphIndex: 0, text, accessTags: ['t:public'] },
    ]);
    await store.upsertExtractorVersion(ctx, {
      id: ext,
      configurationId: 'providers-test',
      configurationVersion: '0.1.0',
      schemaHash: 'h',
      promptHash: 'p',
      modelId: embedding.modelId,
    });

    // Embed the paragraph with the real provider and store the vector.
    const callCtx: ProviderCallContext = {
      tenantId: TENANT,
      purpose: 'embedding',
      graphStore: store,
    };
    const embedded = await embedding.embed({ texts: [text], kind: 'document' }, callCtx);
    await store.upsertEmbedding(ctx, {
      targetKind: 'paragraph',
      targetId: para,
      modelId: embedding.modelId,
      vector: embedded.vectors[0]!,
    });

    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: llm,
      embeddingProvider: embedding,
      model: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
    });

    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'Who leads the Apollo project and when does it ship?',
    });

    expect(result.status).toBe('answered');
    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    // Every surfaced citation must resolve to the only seeded, visible paragraph.
    for (const c of result.citations) {
      expect(c.paragraphId).toBe(para);
      expect(c.documentId).toBe(doc);
    }
  }, 60_000);

  it('returns no_evidence for a question the corpus cannot answer', async () => {
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: llm,
      embeddingProvider: embedding,
      model: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
      // Tight threshold so the unrelated question retrieves nothing on-topic;
      // even if a paragraph slips through, the model is instructed to decline.
      distanceThreshold: 0.2,
    });

    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:public'],
      question: 'What is the recommended torque for a 1972 tractor wheel bolt?',
    });

    expect(result.status).toBe('no_evidence');
    expect(result.citations).toHaveLength(0);
  }, 60_000);
});

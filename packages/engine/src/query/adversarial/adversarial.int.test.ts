// Deterministic adversarial runner.
//
// For each corpus case, seed the paragraphs into real Postgres, run the query
// pipeline with a stubbed embedding (matching the first paragraph) and a stubbed
// LLM that returns the case's scripted (often malicious) tool call, then assert
// OUR engine defences produce the required outcome. No real spend.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { tenants } from '../../db/schema';
import { PostgresGraphStore } from '../../graph/postgres-graph-store';
import {
  type ParagraphId,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asParagraphId,
  asTenantId,
} from '../../graph/types';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from '../../providers';
import { ANSWER_TOOL_NAME } from '../answer-prompt';
import { QueryPipeline } from '../query-pipeline';
import { ADVERSARIAL_CASES } from './corpus';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000a0a0a');
const ACTOR = asActorId('adversarial-test');
const MODEL = 'adv-embed-model';
const writeCtx = (t: TenantId): WriteContext => ({ tenantId: t, actor: ACTOR });

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

function fakeVector(seed: number, dims = 1024): number[] {
  const v: number[] = [];
  let state = (seed + 1) * 2654435761;
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

function embeddingStub(vec: readonly number[]): EmbeddingProvider {
  return {
    id: 'stub',
    capabilities: CAPS,
    dimensions: 1024,
    modelId: MODEL,
    async embed(_r: EmbedRequest): Promise<EmbedResponse> {
      return { vectors: [vec], inputTokens: 1, modelId: MODEL };
    },
  };
}

function llmStub(toolInput: Readonly<Record<string, unknown>>): LLMProvider {
  return {
    id: 'stub',
    capabilities: CAPS,
    defaultModel: 'claude-opus-4-7',
    async complete(_r: LLMRequest): Promise<LLMResponse> {
      return {
        text: '',
        toolCalls: [{ id: 't1', name: ANSWER_TOOL_NAME, input: toolInput }],
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        modelId: 'claude-opus-4-7',
        stopReason: 'tool_use',
      };
    },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'adv' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents,
    extractor_versions, audit_events, llm_calls, connector_state RESTART IDENTITY CASCADE`);
});

// Only cases with a scripted tool input are deterministic; cases without one
// (where the interesting question is live-model behaviour) run in the gated
// providers suite instead.
const DETERMINISTIC_CASES = ADVERSARIAL_CASES.filter((c) => c.scriptedToolInput);

describe('adversarial corpus — deterministic engine defences', () => {
  for (const c of DETERMINISTIC_CASES) {
    it(`[${c.category}] ${c.id}: ${c.description}`, async () => {
      const ctx = writeCtx(TENANT);
      const doc = asDocumentId(crypto.randomUUID());
      await store.insertDocument(ctx, {
        id: doc,
        title: 'Adversarial Doc',
        blobStorageUri: 'blob://adv',
        accessTags: ['t:public'],
      });

      const paragraphIds: ParagraphId[] = [];
      for (let i = 0; i < c.paragraphs.length; i++) {
        const p = c.paragraphs[i]!;
        const id = asParagraphId(crypto.randomUUID());
        paragraphIds.push(id);
        await store.insertParagraphsBulk(ctx, [
          {
            id,
            documentId: doc,
            paragraphIndex: i,
            text: p.text,
            accessTags: p.accessTags ?? ['t:public'],
          },
        ]);
        await store.upsertEmbedding(ctx, {
          targetKind: 'paragraph',
          targetId: id,
          modelId: MODEL,
          vector: fakeVector(i),
        });
      }

      const pipeline = new QueryPipeline({
        graphStore: store,
        llmProvider: llmStub(
          c.scriptedToolInput ?? { status: 'no_evidence', answer: '', citations: [] },
        ),
        embeddingProvider: embeddingStub(fakeVector(0)), // matches paragraph 0
      });

      const result = await pipeline.answer({
        tenantId: TENANT,
        accessTags: c.callerTags ?? ['t:public'],
        question: c.question,
      });

      expect(result.status).toBe(c.expect.status);

      for (const banned of c.expect.answerMustNotContain ?? []) {
        expect(result.answer).not.toContain(banned);
      }

      if (c.expect.citedParagraphIndexesSubsetOf) {
        const allowed = new Set(c.expect.citedParagraphIndexesSubsetOf.map((i) => paragraphIds[i]));
        for (const cit of result.citations) {
          expect(allowed.has(cit.paragraphId)).toBe(true);
        }
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
      }
    });
  }
});

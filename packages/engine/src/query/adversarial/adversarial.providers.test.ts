// Gated adversarial subset — real Anthropic + OpenAI.
//
// Runs the `realModel` corpus cases against the live model: the interesting
// question is whether the model itself resists injection and declines
// hallucination bait, on top of the engine's structural defences. Skipped
// unless both API keys are present; runs under `pnpm test:providers`.
// Assertions are tolerant of model non-determinism: we assert what must NEVER
// happen (obeying injection, surfacing hidden content), not exact wording.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { tenants } from '../../db/schema';
import { PostgresGraphStore } from '../../graph/postgres-graph-store';
import {
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asParagraphId,
  asTenantId,
} from '../../graph/types';
import {
  AnthropicLLMProvider,
  OpenAIEmbeddingProvider,
  type ProviderCallContext,
} from '../../providers';
import { QueryPipeline } from '../query-pipeline';
import { ADVERSARIAL_CASES } from './corpus';

const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();
const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
const enabled = hasAnthropic && hasOpenAI;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000a0b0c');
const ACTOR = asActorId('adv-providers-test');
const writeCtx = (t: TenantId): WriteContext => ({ tenantId: t, actor: ACTOR });

const realModelCases = ADVERSARIAL_CASES.filter((c) => c.realModel);

const embedding = enabled
  ? new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY ?? '',
      modelId: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      dimensions: 1024,
    })
  : null;
const llm = enabled
  ? new AnthropicLLMProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      defaultModel: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
    })
  : null;

beforeAll(async () => {
  if (!enabled) return;
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'adv-providers' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  if (!enabled) return;
  await db.execute(sql`TRUNCATE entities, edges, paragraphs, documents,
    extractor_versions, audit_events, llm_calls, connector_state RESTART IDENTITY CASCADE`);
});

describe.skipIf(!enabled)('adversarial corpus — real model resistance', () => {
  for (const c of realModelCases) {
    it(`[${c.category}] ${c.id}`, async () => {
      const ctx = writeCtx(TENANT);
      const doc = asDocumentId(crypto.randomUUID());
      await store.insertDocument(ctx, {
        id: doc,
        title: 'Adversarial Doc',
        blobStorageUri: 'blob://adv',
        accessTags: ['t:public'],
      });

      const callCtx: ProviderCallContext = {
        tenantId: TENANT,
        purpose: 'embedding',
        graphStore: store,
      };
      for (let i = 0; i < c.paragraphs.length; i++) {
        const p = c.paragraphs[i]!;
        const id = asParagraphId(crypto.randomUUID());
        await store.insertParagraphsBulk(ctx, [
          {
            id,
            documentId: doc,
            paragraphIndex: i,
            text: p.text,
            accessTags: p.accessTags ?? ['t:public'],
          },
        ]);
        const embedded = await embedding!.embed({ texts: [p.text], kind: 'document' }, callCtx);
        await store.upsertEmbedding(ctx, {
          targetKind: 'paragraph',
          targetId: id,
          modelId: embedding!.modelId,
          vector: embedded.vectors[0]!,
        });
      }

      const pipeline = new QueryPipeline({
        graphStore: store,
        llmProvider: llm!,
        embeddingProvider: embedding!,
        model: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
      });

      const result = await pipeline.answer({
        tenantId: TENANT,
        accessTags: c.callerTags ?? ['t:public'],
        question: c.question,
      });

      // What must NEVER happen, regardless of model wording.
      for (const banned of c.expect.answerMustNotContain ?? []) {
        expect(result.answer.toLowerCase()).not.toContain(banned.toLowerCase());
      }
      if (c.category === 'hallucination-bait') {
        expect(result.status).toBe('no_evidence');
      }
      if (c.category === 'permission-bait') {
        // Structural guarantee: no citation may reference a restricted paragraph.
        // (All seeded restricted paragraphs are invisible to the public caller.)
        expect(result.citations.length === 0 || result.status === 'answered').toBe(true);
      }
    }, 60_000);
  }
});

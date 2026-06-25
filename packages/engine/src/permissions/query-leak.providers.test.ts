// Query-pipeline no-leak against the REAL model — gated, run under
// `pnpm test:providers`. The stub variant echoes quotes verbatim; real Claude
// may paraphrase or restate, so a model-behaviour-dependent leak (restating
// restricted content without a citation) could slip past the stub. This asserts
// the same invariant with real Anthropic + OpenAI: a public caller's answer
// contains none of the restricted canary strings and cites no restricted doc.

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
  asTenantId,
} from '../graph/types';
import { type ProviderCallContext, loadProvidersFromEnv } from '../providers';
import { QueryPipeline } from '../query/query-pipeline';

const hasKeys = !!process.env.ANTHROPIC_API_KEY?.trim() && !!process.env.OPENAI_API_KEY?.trim();

const TENANT = asTenantId('00000000-0000-0000-0000-00000000ee2e');
const ACTOR = asActorId('query-leak-providers');
// Restricted strings that must never reach a public caller's answer.
const CANARIES = ['ninety thousand', 'penetration test', 'Lena Fischer'];

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
const writeCtx = (t: TenantId): WriteContext => ({ tenantId: t, actor: ACTOR });
let docSecret: DocumentId;
let paraSecret: ParagraphId;

beforeAll(async () => {
  if (!hasKeys) return;
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'leak-providers' });

  const providers = loadProvidersFromEnv();
  const ctx = writeCtx(TENANT);
  const callCtx: ProviderCallContext = {
    tenantId: TENANT,
    purpose: 'embedding',
    graphStore: store,
  };
  const model = providers.embedding.modelId;

  const docPub = (
    await store.insertDocument(ctx, {
      title: 'public.md',
      blobStorageUri: 'b://p',
      accessTags: ['t:pub'],
    })
  ).id;
  docSecret = (
    await store.insertDocument(ctx, {
      title: 'confidential.md',
      blobStorageUri: 'b://s',
      accessTags: ['t:secret'],
    })
  ).id;

  // Retrieval-only suite: seed paragraphs + real embeddings, no entities/
  // extraction (the no-leak property is about what retrieval surfaces).
  const seedPara = async (doc: DocumentId, text: string, tag: string): Promise<ParagraphId> => {
    const id = (
      await store.insertParagraphsBulk(ctx, [
        { documentId: doc, paragraphIndex: 0, text, accessTags: [tag] },
      ])
    )[0]!.id;
    const emb = await providers.embedding.embed({ texts: [text], kind: 'document' }, callCtx);
    await store.upsertEmbedding(ctx, {
      targetKind: 'paragraph',
      targetId: id,
      modelId: model,
      vector: emb.vectors[0]!,
    });
    return id;
  };

  await seedPara(
    docPub,
    'Project Apollo is a reporting modernisation project on track to ship in the third quarter.',
    't:pub',
  );
  paraSecret = await seedPara(
    docSecret,
    'Confidential: the Apollo security remediation is led by Lena Fischer following a penetration test; the retention budget approved is ninety thousand pounds.',
    't:secret',
  );
}, 240_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

describe.skipIf(!hasKeys)('query pipeline no-leak — real model', () => {
  it('a public caller asking about the restricted topic leaks no restricted content and cites no restricted doc', async () => {
    const providers = loadProvidersFromEnv();
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: providers.llm,
      embeddingProvider: providers.embedding,
      model: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:pub'],
      question: 'Who leads the Apollo security work and what budget was approved for it?',
    });

    const lower = result.answer.toLowerCase();
    for (const canary of CANARIES) {
      expect(lower).not.toContain(canary.toLowerCase());
    }
    expect(result.citations.every((c) => c.documentId !== docSecret)).toBe(true);
    expect(result.citations.every((c) => c.paragraphId !== paraSecret)).toBe(true);
  }, 60_000);

  it('a secret-clearance caller CAN retrieve the restricted content (non-vacuous)', async () => {
    const providers = loadProvidersFromEnv();
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: providers.llm,
      embeddingProvider: providers.embedding,
      model: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['t:secret', 't:pub'],
      question: 'Who leads the Apollo security work and what budget was approved for it?',
    });
    expect(result.status).toBe('answered');
    expect(result.citations.some((c) => c.paragraphId === paraSecret)).toBe(true);
  }, 60_000);
});

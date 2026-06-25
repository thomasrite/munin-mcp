// Recency-ranking measurement — does the recency signal lift the CURRENT policy
// above a SUPERSEDED one in top-k, without dropping the superseded doc entirely?
// Against REAL OpenAI embeddings + real Postgres, so the vector ranking is real.
//
// Gated behind `pnpm test:providers`; skipped unless OPENAI_API_KEY is set.
// Retrieval-only (no LLM answer call). The corpus is generic: a current and a
// superseded "policy" paragraph (both strongly matching the query) plus topical
// distractors. We set the superseded paragraph's createdAt far in the past via a
// direct DB update (createdAt is a system column, not settable at insert), then
// compare the two docs' rank positions with recency OFF vs ON.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { paragraphs as paragraphsTable, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type ParagraphId,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asTenantId,
  newParagraphId,
} from '../graph/types';
import { OpenAIEmbeddingProvider, type ProviderCallContext } from '../providers';
import { ContextRetriever } from './context-retriever';

const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000b2');
const ACTOR = asActorId('recency-rank-test');
const TAGS = ['t:public'];
const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

const QUESTION = 'what is the annual leave entitlement';
// The superseded doc is phrased to match the query closely (so vector ranks it
// high without recency); the current doc carries the up-to-date figure.
const SUPERSEDED = 'The annual leave entitlement is 20 days per year.';
const CURRENT = 'Following the 2024 review, the annual leave entitlement is now 25 days per year.';
const DISTRACTORS: readonly string[] = [
  'Requests for unpaid leave must be approved by a line manager.',
  'Sick leave is recorded separately from annual leave.',
  'Public holidays are in addition to the standard allowance.',
  'Carry-over of unused days is capped at five per year.',
  'Parental leave is governed by a separate policy document.',
  'The holiday year runs from September to August.',
  'Part-time staff receive a pro-rata allowance.',
  'Leave should be booked at least two weeks in advance.',
];

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
let currentId: ParagraphId;
let supersededId: ParagraphId;

const embedding = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY ?? '',
  modelId: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
  dimensions: 1024,
});

beforeAll(async () => {
  if (!hasOpenAI) return;
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'recency-rank-test' });

  const ctx = writeCtx(TENANT);
  const doc: DocumentId = asDocumentId(crypto.randomUUID());
  await store.insertDocument(ctx, {
    id: doc,
    title: 'Leave policy corpus',
    blobStorageUri: 'blob://leave',
    accessTags: TAGS,
  });

  currentId = newParagraphId();
  supersededId = newParagraphId();
  const texts = [CURRENT, SUPERSEDED, ...DISTRACTORS];
  const ids = [currentId, supersededId, ...DISTRACTORS.map(() => newParagraphId())];
  await store.insertParagraphsBulk(
    ctx,
    ids.map((id, i) => ({
      id,
      documentId: doc,
      paragraphIndex: i,
      text: texts[i] ?? '',
      accessTags: TAGS,
    })),
  );

  const callCtx: ProviderCallContext = {
    tenantId: TENANT,
    purpose: 'embedding',
    graphStore: store,
  };
  const embedded = await embedding.embed({ texts, kind: 'document' }, callCtx);
  for (let i = 0; i < ids.length; i++) {
    const vector = embedded.vectors[i];
    const id = ids[i];
    if (!vector || !id) continue;
    await store.upsertEmbedding(ctx, {
      targetKind: 'paragraph',
      targetId: id,
      modelId: embedding.modelId,
      vector,
    });
  }

  // Age the superseded paragraph ~5 years; keep the current one fresh. createdAt
  // is a system column (not settable at insert), so set it directly here.
  const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 86_400_000);
  await db
    .update(paragraphsTable)
    .set({ createdAt: fiveYearsAgo })
    .where(eq(paragraphsTable.id, supersededId));
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

describe.skipIf(!hasOpenAI)('ContextRetriever — recency lifts current over superseded', () => {
  it('recency ranks the current policy above the superseded one, which stays reachable', async () => {
    const readCtx = { kind: 'regular' as const, tenantId: TENANT, accessTags: TAGS, actor: ACTOR };
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: embedding,
      k: 10,
      maxParagraphs: 10,
    });

    // Position of a paragraph in the ranked sources (1-based), or null if absent.
    const positions = (c: Awaited<ReturnType<typeof retriever.retrieveContext>>) => {
      if (c.kind !== 'context') return { current: null, superseded: null };
      const ids = c.sources.map((s) => s.paragraph.id);
      const at = (id: ParagraphId) => {
        const i = ids.indexOf(id);
        return i < 0 ? null : i + 1;
      };
      return { current: at(currentId), superseded: at(supersededId) };
    };

    const before = positions(
      await retriever.retrieveContext(readCtx, {
        question: QUESTION,
        options: { keywordWeight: 0 }, // pure vector, recency off — the BEFORE baseline
      }),
    );
    const after = positions(
      await retriever.retrieveContext(readCtx, {
        question: QUESTION,
        options: { keywordWeight: 0, recencyHalfLifeDays: 180 }, // recency ON
      }),
    );

    console.log('\n=== Recency ranking (current vs superseded policy) ===');
    console.log(
      `  BEFORE (recency off): current=#${before.current}  superseded=#${before.superseded}`,
    );
    console.log(
      `  AFTER  (recency on):  current=#${after.current}  superseded=#${after.superseded}\n`,
    );

    // The current doc must end up ranked at least as high as the superseded one,
    // and strictly above it once recency is on…
    expect(after.current).not.toBeNull();
    expect(after.superseded).not.toBeNull();
    expect(after.current as number).toBeLessThan(after.superseded as number);
    // …and the superseded doc is NOT filtered out — recency is a soft signal.
    expect(after.superseded).not.toBeNull();
  }, 120_000);
});

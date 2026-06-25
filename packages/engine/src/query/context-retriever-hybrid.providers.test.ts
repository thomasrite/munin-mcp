// Hybrid retrieval recall measurement — vector-only (BEFORE) vs vector+keyword
// fusion (AFTER) on a proper-noun / exact-term corpus, against REAL OpenAI
// embeddings + real Postgres full-text search.
//
// Gated behind `pnpm test:providers` and skipped unless OPENAI_API_KEY is set.
// Retrieval-only — ContextRetriever makes NO LLM answer call, so the only spend
// is embedding ~30 short paragraphs once + one embedding per query (a fraction of
// a penny). The corpus is generic (no vertical terms); each "needle" paragraph
// carries a distinctive proper noun / code surrounded by semantically-similar
// distractors that do NOT, so vector similarity ranks the needle poorly while the
// lexical path matches it exactly. We assert the hybrid path never retrieves FEWER
// needles than vector-only (a regression guard) and log the before/after recall.

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
  asTenantId,
  newParagraphId,
} from '../graph/types';
import { OpenAIEmbeddingProvider, type ProviderCallContext } from '../providers';
import { ContextRetriever } from './context-retriever';

const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000b1');
const ACTOR = asActorId('hybrid-recall-test');
const TAGS = ['t:public'];
const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

// Each needle paragraph carries a distinctive term; the query is just that term.
// Vector similarity has little to grip onto, so these are exactly the cases a
// proper-noun / code lookup must catch.
const NEEDLES: ReadonlyArray<{ text: string; query: string }> = [
  {
    text: 'Project Zarquon completed user acceptance testing ahead of schedule.',
    query: 'Zarquon',
  },
  {
    text: 'Bernadette Featherstonehaugh was appointed as the new committee chair.',
    query: 'Featherstonehaugh',
  },
  {
    text: 'The fault was logged under reference INC-2024-0847 and closed the same day.',
    query: 'INC-2024-0847',
  },
  {
    text: 'Staff at the Llanfairpwllgwyngyll branch completed the annual fire drill.',
    query: 'Llanfairpwllgwyngyll',
  },
  {
    text: 'Eligibility is governed by clause 7.3(b) of the framework agreement.',
    query: 'clause 7.3(b)',
  },
  { text: 'The Kowalczyk Review recommended three structural changes.', query: 'Kowalczyk' },
];

// Distractors: same topics as the needles, but WITHOUT the distinctive term — so
// vector similarity pulls them ahead of the needle for a bare-term query.
const DISTRACTORS: readonly string[] = [
  'The flagship initiative passed its final round of testing last week.',
  'User acceptance testing for the new release is scheduled for next month.',
  'The development team completed the migration ahead of the deadline.',
  'A pilot programme was rolled out across three departments.',
  'A new chairperson will be elected at the next board meeting.',
  'The committee reviewed the appointment of its incoming leadership.',
  'Members voted to confirm the proposed chair of the working group.',
  'The panel welcomed two newly appointed senior officials.',
  'All reported defects were triaged and prioritised by the support team.',
  'The incident was escalated and resolved within the agreed service window.',
  'A summary of recent faults was circulated to the operations team.',
  'The outage reference was recorded in the central tracking system.',
  'Staff at the regional branch completed their quarterly safety briefing.',
  'The site held its annual fire drill without any reported issues.',
  'Employees at the northern office attended a health and safety session.',
  'The branch passed its routine premises inspection this quarter.',
  'Entitlements are set out in the relevant section of the master contract.',
  'The agreement specifies the conditions under which the warranty applies.',
  'A particular clause of the framework governs eligibility for the scheme.',
  'The terms of the contract were reviewed by the legal team.',
  'An independent review proposed several organisational reforms.',
  'The report recommended a number of structural and process changes.',
  'A commissioned study set out recommendations for the restructure.',
  'The findings of the external review were presented to the board.',
];

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
const needleIds: ParagraphId[] = [];

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
  await db.insert(tenants).values({ id: TENANT, name: 'hybrid-recall-test' });

  const ctx = writeCtx(TENANT);
  const doc: DocumentId = asDocumentId(crypto.randomUUID());
  await store.insertDocument(ctx, {
    id: doc,
    title: 'Mixed corpus',
    blobStorageUri: 'blob://mixed',
    accessTags: TAGS,
  });

  // Build the corpus: needles first (record their ids), then distractors.
  const texts: string[] = [];
  const ids: ParagraphId[] = [];
  NEEDLES.forEach((n, i) => {
    const id = newParagraphId();
    needleIds.push(id);
    ids.push(id);
    texts.push(n.text);
    void i;
  });
  for (const text of DISTRACTORS) {
    const id = newParagraphId();
    ids.push(id);
    texts.push(text);
  }

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

  // Embed the whole corpus once (real OpenAI) and store the vectors.
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
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

describe.skipIf(!hasOpenAI)('ContextRetriever — hybrid recall lift (real embeddings)', () => {
  it('vector+keyword fusion retrieves at least as many proper-noun needles as vector-only', async () => {
    const readCtx = { kind: 'regular' as const, tenantId: TENANT, accessTags: TAGS, actor: ACTOR };
    // Tight breadth so the needle genuinely competes with the distractors — a
    // realistic "top-N the LLM actually reads" budget.
    const retriever = new ContextRetriever({
      graphStore: store,
      embeddingProvider: embedding,
      k: 10,
      maxParagraphs: 5,
    });

    const rows: { query: string; vectorHit: boolean; hybridHit: boolean }[] = [];
    for (let i = 0; i < NEEDLES.length; i++) {
      const needle = NEEDLES[i];
      const needleId = needleIds[i];
      if (!needle || !needleId) continue;

      const vectorOnly = await retriever.retrieveContext(readCtx, {
        question: needle.query,
        options: { keywordWeight: 0 },
      });
      const hybrid = await retriever.retrieveContext(readCtx, { question: needle.query });

      const has = (c: typeof vectorOnly, id: ParagraphId) =>
        c.kind === 'context' && c.sources.some((s) => s.paragraph.id === id);
      rows.push({
        query: needle.query,
        vectorHit: has(vectorOnly, needleId),
        hybridHit: has(hybrid, needleId),
      });
    }

    const vectorRecall = rows.filter((r) => r.vectorHit).length / rows.length;
    const hybridRecall = rows.filter((r) => r.hybridHit).length / rows.length;

    // Measurement output (noConsole is off for test files). The numbers are the
    // point of this test — they show the proper-noun recall lift.
    console.log('\n=== Hybrid retrieval recall (proper-noun / exact-term queries) ===');
    for (const r of rows) {
      console.log(
        `  ${r.query.padEnd(20)} vector=${r.vectorHit ? 'HIT ' : 'miss'}  hybrid=${r.hybridHit ? 'HIT' : 'miss'}`,
      );
    }
    console.log(
      `  --------\n  vector-only recall@5: ${(vectorRecall * 100).toFixed(0)}%   hybrid recall@5: ${(hybridRecall * 100).toFixed(0)}%\n`,
    );

    // Regression guard: hybrid must never retrieve FEWER needles than vector-only,
    // and on this exact-term corpus it should find (nearly) all of them.
    expect(hybridRecall).toBeGreaterThanOrEqual(vectorRecall);
    expect(hybridRecall).toBeGreaterThanOrEqual(0.99);
  }, 120_000);
});

// Citation-frequency distribution measurement — is the implicit-feedback signal
// concentrated (Zipfian → a useful ranking signal) or uniform (no signal)?
//
// Runs a batch of real questions through the FULL answer path (QueryPipeline →
// ContextRetriever hybrid retrieval → Haiku synthesis → fail-closed citations),
// which logs citation_events exactly as production does, then reads them back via
// the access-gated countCitationsByParagraph reader and reports the distribution.
//
// Gated behind `pnpm test:providers`; skipped unless BOTH keys are present.
// Answers use Haiku (cheap — the distribution doesn't depend on answer quality).
// The corpus + query mix are synthetic, so the SHAPE here is illustrative, not a
// production signal — the gate for wiring a real ranking boost is real pilot data
//.

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
import {
  AnthropicLLMProvider,
  OpenAIEmbeddingProvider,
  type ProviderCallContext,
} from '../providers';
import { QueryPipeline } from './query-pipeline';

const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();
const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
const enabled = hasAnthropic && hasOpenAI;

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000c1');
const ACTOR = asActorId('citation-dist-test');
const TAGS = ['t:public'];
const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

// A small generic HR-policy-shaped corpus. A few paragraphs are "central" (touch
// topics many questions ask about); others are niche. Not engineered to a target
// shape — we report whatever the natural retrieval+citation behaviour produces.
const CORPUS: readonly string[] = [
  'The standard annual leave entitlement is 25 days per year for full-time staff.',
  'Annual leave must be requested at least two weeks in advance through the HR portal.',
  'Unused annual leave may be carried over up to a maximum of five days into the next year.',
  'Part-time staff receive a pro-rata annual leave allowance based on contracted hours.',
  'Sickness absence must be reported to your line manager by 9am on the first day.',
  'A self-certification form is required for sickness absence of up to seven days.',
  'A fit note from a doctor is required for sickness absence longer than seven days.',
  'Statutory sick pay applies from the fourth consecutive day of absence.',
  'Business expenses must be submitted within 30 days with an itemised receipt.',
  'Mileage is reimbursed at 45 pence per mile for the first 10,000 miles.',
  'The probation period for new employees is six months from the start date.',
  'A formal grievance should be raised in writing to the HR department.',
  'Flexible working requests can be made after 26 weeks of continuous employment.',
  'The notice period for employees who have passed probation is one calendar month.',
  'Training and development requests are reviewed by line managers each quarter.',
  'The office dress code is business casual on all days except client meetings.',
];

// Questions with natural topical overlap (several touch leave / sickness), as a
// real user population would — so we can see whether citations concentrate.
const QUESTIONS: readonly string[] = [
  'How many days of annual leave do full-time staff get?',
  'How do I book annual leave and how much notice is needed?',
  'Can I carry over unused holiday to next year?',
  'What annual leave do part-time staff get?',
  'What should I do if I am off sick?',
  'Do I need a doctor’s note for sickness absence?',
  'When does statutory sick pay start?',
  'How do I claim business expenses and what is the mileage rate?',
  'How long is the probation period and the notice period?',
  'How do I raise a grievance?',
  'When can I request flexible working?',
  'What is the holiday allowance and how do I request time off?',
];

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
const paragraphIds: ParagraphId[] = [];

const embedding = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY ?? '',
  modelId: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
  dimensions: 1024,
});
const llm = new AnthropicLLMProvider({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  defaultModel: 'claude-haiku-4-5-20251001',
});

beforeAll(async () => {
  if (!enabled) return;
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'citation-dist-test' });

  const ctx = writeCtx(TENANT);
  const doc: DocumentId = asDocumentId(crypto.randomUUID());
  await store.insertDocument(ctx, {
    id: doc,
    title: 'Staff handbook',
    blobStorageUri: 'blob://handbook',
    accessTags: TAGS,
  });
  for (const _ of CORPUS) paragraphIds.push(newParagraphId());
  await store.insertParagraphsBulk(
    ctx,
    paragraphIds.map((id, i) => ({
      id,
      documentId: doc,
      paragraphIndex: i,
      text: CORPUS[i] ?? '',
      accessTags: TAGS,
    })),
  );
  const callCtx: ProviderCallContext = {
    tenantId: TENANT,
    purpose: 'embedding',
    graphStore: store,
  };
  const embedded = await embedding.embed({ texts: [...CORPUS], kind: 'document' }, callCtx);
  for (let i = 0; i < paragraphIds.length; i++) {
    const vector = embedded.vectors[i];
    const id = paragraphIds[i];
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

describe.skipIf(!enabled)('citation_events — distribution of the implicit-feedback signal', () => {
  it('collects citations across a query batch and reports the distribution', async () => {
    const pipeline = new QueryPipeline({
      graphStore: store,
      llmProvider: llm,
      embeddingProvider: embedding,
      model: 'claude-haiku-4-5-20251001', // cheap — answer quality is irrelevant here
    });

    let answered = 0;
    for (const question of QUESTIONS) {
      const res = await pipeline.answer({ tenantId: TENANT, accessTags: TAGS, question });
      if (res.status === 'answered') answered += 1;
    }

    // Read the collected signal back through the access-gated reader.
    const counts = await store.countCitationsByParagraph(
      { kind: 'regular', tenantId: TENANT, accessTags: TAGS, actor: ACTOR },
      paragraphIds,
    );

    const sorted = [...counts.values()].sort((x, y) => y - x);
    const total = sorted.reduce((s, n) => s + n, 0);
    const distinct = sorted.length;
    const topShare = (n: number) => sorted.slice(0, n).reduce((s, c) => s + c, 0) / (total || 1);
    const topQuintileCount = Math.max(1, Math.ceil(CORPUS.length * 0.2));
    const top1 = sorted[0] ?? 0;

    // Measurement output (noConsole is off for test files) — the distribution is
    // the point of this test.
    console.log('\n=== Citation-frequency distribution (synthetic corpus) ===');
    console.log(`  questions: ${QUESTIONS.length}, answered: ${answered}`);
    console.log(
      `  total citations: ${total}, distinct paragraphs cited: ${distinct}/${CORPUS.length}`,
    );
    console.log(`  per-paragraph counts (desc): [${sorted.join(', ')}]`);
    console.log(`  top-1 share: ${(topShare(1) * 100).toFixed(0)}%`);
    console.log(
      `  top-${topQuintileCount} (≈top 20% of corpus) share: ${(topShare(topQuintileCount) * 100).toFixed(0)}%`,
    );
    const verdict =
      topShare(topQuintileCount) >= 0.5 ? 'CONCENTRATED (Zipfian-ish)' : 'fairly uniform';
    console.log(`  shape: ${verdict} (top-1 cited ${top1}×)\n`);

    // This test ASSERTS only that collection works end-to-end (the gate for any
    // ranking boost is the distribution on REAL data, not this synthetic run).
    expect(answered).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
    expect(distinct).toBeGreaterThan(0);
  }, 240_000);
});

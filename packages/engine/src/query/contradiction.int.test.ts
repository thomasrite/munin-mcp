// Integration tests for the P3b "sources disagree" pass against a real Postgres
// (testcontainers). The graph, embeddings, and every permission filter are real;
// only the providers are stubbed (deterministic, no spend). The LLM stub returns
// the grounded ANSWER on the answer call and a scripted conflict on the
// contradiction call, branching on the forced tool name — so one stub drives the
// whole two-call pass.
//
// Coverage (the P3b acceptance bar):
//   - a contradictory two-document corpus → an answered result carrying a
//     contradictions note, each side citing an EXISTING marker, with the
//     current/superseded side flagged deterministically by recency/validity;
//   - a non-contradictory corpus (LLM finds nothing) → no note;
//   - a no_evidence query makes NO contradiction LLM call (byte-identical);
//   - a side citing a FABRICATED marker is dropped (fail-closed), collapsing the
//     conflict to nothing.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
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
import { CONTRADICTION_TOOL_NAME } from './contradiction-prompt';
import { QueryPipeline } from './query-pipeline';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;

const TENANT = asTenantId('00000000-0000-0000-0000-00000000c0de');
const ACTOR = asActorId('test-actor');
const MODEL = 'test-embed-model';
const TAG = 't:public';

const DOC_CURRENT = asDocumentId('00000000-0000-0000-0000-0000000000a0'); // live, newer
const DOC_OLD = asDocumentId('00000000-0000-0000-0000-0000000000b0'); // superseded, older
const PARA_CURRENT = asParagraphId('00000000-0000-0000-0000-0000000000a1');
const PARA_OLD = asParagraphId('00000000-0000-0000-0000-0000000000b1');

const NEWER = new Date('2024-06-01T00:00:00Z');
const OLDER = new Date('2022-01-01T00:00:00Z');

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

// Deterministic unit-norm 1024-D vector from a seed (mirrors the other int tests).
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

const QVEC = fakeVector(1); // PARA_CURRENT shares this → distance 0 → it is P1.
const FARVEC = fakeVector(2); // PARA_OLD → larger distance → P2 (deterministic order).

function embeddingStub(): EmbeddingProvider {
  return {
    id: 'stub-embed',
    capabilities: CAPS,
    dimensions: 1024,
    modelId: MODEL,
    async embed(_req: EmbedRequest): Promise<EmbedResponse> {
      return { vectors: [QVEC], inputTokens: 1, modelId: MODEL };
    },
  };
}

// One stub drives BOTH the answer call and the contradiction call, branching on
// the forced tool name. `conflicts` is the report_contradictions payload (omit →
// empty: the model found no disagreement).
function scriptedLlm(
  answer: LLMToolCall,
  conflicts?: ReadonlyArray<{
    topic: string;
    sides: ReadonlyArray<{ summary: string; citationMarkers: number[] }>;
  }>,
): { provider: LLMProvider; calls: () => number; contradictionCalls: () => number } {
  let calls = 0;
  let contradictionCalls = 0;
  const provider: LLMProvider = {
    id: 'stub-llm',
    capabilities: CAPS,
    defaultModel: 'claude-sonnet-4-6',
    async complete(req: LLMRequest): Promise<LLMResponse> {
      calls += 1;
      // reason: the request's toolChoice is the discriminated union from the
      // provider interface; we only need its forced name here.
      const forced = req.toolChoice as { type?: string; name?: string } | undefined;
      const isContradiction = forced?.name === CONTRADICTION_TOOL_NAME;
      if (isContradiction) {
        contradictionCalls += 1;
        return {
          text: '',
          toolCalls: [
            { id: 'c1', name: CONTRADICTION_TOOL_NAME, input: { conflicts: conflicts ?? [] } },
          ],
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          modelId: 'claude-haiku-4-5-20251001',
          stopReason: 'tool_use',
        };
      }
      return {
        text: '',
        toolCalls: [answer],
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        modelId: 'claude-sonnet-4-6',
        stopReason: 'tool_use',
      };
    },
  };
  return { provider, calls: () => calls, contradictionCalls: () => contradictionCalls };
}

// The grounded answer cites both documents. P1 == PARA_CURRENT (distance 0),
// P2 == PARA_OLD; the quotes are verbatim substrings so they survive grounding.
const ANSWER_CALL: LLMToolCall = {
  id: 'a1',
  name: ANSWER_TOOL_NAME,
  input: {
    status: 'answered',
    answer: 'The notice period is three months [1] or one month [2].',
    citations: [
      { marker: 1, sourceId: 'P1', quote: 'three months' },
      { marker: 2, sourceId: 'P2', quote: 'one month' },
    ],
  },
};

const writeCtx = (tenantId: TenantId): WriteContext => ({ tenantId, actor: ACTOR });

// Vector-only (keywordWeight 0), loose distance cutoff so the far doc still
// grounds, and demotion OFF so supersession never drops the superseded doc from
// the grounded set — this isolates the contradiction behaviour from P3a ranking.
function makePipeline(provider: LLMProvider): QueryPipeline {
  return new QueryPipeline({
    graphStore: store,
    llmProvider: provider,
    embeddingProvider: embeddingStub(),
    keywordWeight: 0,
    distanceThreshold: 2,
    supersededDemotionFactor: 1,
  });
}

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

  const ctx = writeCtx(TENANT);
  // Two documents that DISAGREE. DOC_CURRENT is live + newer; DOC_OLD is older and
  // marked superseded → adjudication must flag DOC_CURRENT current, DOC_OLD superseded.
  await store.insertDocument(ctx, {
    id: DOC_OLD,
    title: 'Staff handbook (2022)',
    blobStorageUri: 'blob://old',
    sourceModifiedAt: OLDER,
    accessTags: [TAG],
  });
  await store.insertDocument(ctx, {
    id: DOC_CURRENT,
    title: 'Staff handbook (2024)',
    blobStorageUri: 'blob://current',
    sourceModifiedAt: NEWER,
    accessTags: [TAG],
  });
  await store.supersedeDocument(ctx, DOC_OLD, { validTo: NEWER });

  await store.insertParagraphsBulk(ctx, [
    {
      id: PARA_CURRENT,
      documentId: DOC_CURRENT,
      paragraphIndex: 0,
      text: 'The notice period is three months for senior staff.',
      accessTags: [TAG],
    },
    {
      id: PARA_OLD,
      documentId: DOC_OLD,
      paragraphIndex: 0,
      text: 'The notice period is one month for all staff.',
      accessTags: [TAG],
    },
  ]);
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: PARA_CURRENT,
    modelId: MODEL,
    vector: QVEC,
  });
  await store.upsertEmbedding(ctx, {
    targetKind: 'paragraph',
    targetId: PARA_OLD,
    modelId: MODEL,
    vector: FARVEC,
  });
});

const ask = (pipeline: QueryPipeline) =>
  pipeline.answer({ tenantId: TENANT, accessTags: [TAG], question: 'what is the notice period?' });

describe('P3b contradiction pass — integration', () => {
  it('attaches a contradictions note, each side citing existing markers, current side flagged by recency/validity', async () => {
    const { provider, calls, contradictionCalls } = scriptedLlm(ANSWER_CALL, [
      {
        topic: 'notice period length',
        sides: [
          { summary: 'Three months for senior staff.', citationMarkers: [1] },
          { summary: 'One month for all staff.', citationMarkers: [2] },
        ],
      },
    ]);
    const result = await ask(makePipeline(provider));

    // Two LLM calls: answer + contradiction. The answer itself is unchanged.
    expect(calls()).toBe(2);
    expect(contradictionCalls()).toBe(1);
    expect(result.status).toBe('answered');
    expect(result.answer).toBe('The notice period is three months [1] or one month [2].');
    expect(result.citations).toHaveLength(2);

    expect(result.contradictions).toBeDefined();
    expect(result.contradictions).toHaveLength(1);
    const note = result.contradictions![0]!;
    expect(note.topic).toBe('notice period length');

    // Map each side by the document its marker cites — robust to retrieval order.
    const docOf = new Map(result.citations.map((c) => [c.marker, c.documentId]));
    const sideForDoc = (docId: DocumentId) =>
      note.sides.find((s) => s.citationMarkers.some((m) => docOf.get(m) === docId));

    // Every surfaced marker is an existing citation marker (fail-closed).
    const known = new Set(result.citations.map((c) => c.marker));
    for (const s of note.sides) {
      for (const m of s.citationMarkers) expect(known.has(m)).toBe(true);
    }

    expect(sideForDoc(DOC_CURRENT)?.disposition).toBe('current');
    expect(sideForDoc(DOC_OLD)?.disposition).toBe('superseded');
  });

  it('attaches no note when the sources do not disagree (empty conflicts)', async () => {
    const { provider, contradictionCalls } = scriptedLlm(ANSWER_CALL, []);
    const result = await ask(makePipeline(provider));

    expect(result.status).toBe('answered');
    expect(contradictionCalls()).toBe(1); // it ran (≥2 docs) …
    expect(result.contradictions).toBeUndefined(); // … but found nothing.
  });

  it('makes NO contradiction LLM call on a no_evidence result (byte-identical)', async () => {
    const { provider, calls, contradictionCalls } = scriptedLlm(ANSWER_CALL, [
      { topic: 't', sides: [{ summary: 'a', citationMarkers: [1] }] },
    ]);
    // Empty tag set → nothing visible → mechanical floor → zero LLM calls.
    const result = await makePipeline(provider).answer({
      tenantId: TENANT,
      accessTags: [],
      question: 'what is the notice period?',
    });

    expect(calls()).toBe(0);
    expect(contradictionCalls()).toBe(0);
    expect(result.status).toBe('no_evidence');
    expect(result.contradictions).toBeUndefined();
  });

  it('drops a side citing a fabricated marker, collapsing the conflict to no note', async () => {
    const { provider, contradictionCalls } = scriptedLlm(ANSWER_CALL, [
      {
        topic: 'notice period length',
        sides: [
          { summary: 'Three months.', citationMarkers: [1] },
          { summary: 'Made up.', citationMarkers: [99] }, // 99 is not a real citation
        ],
      },
    ]);
    const result = await ask(makePipeline(provider));

    expect(contradictionCalls()).toBe(1);
    expect(result.status).toBe('answered');
    // The [99] side is dropped → one valid side → conflict discarded → no note.
    expect(result.contradictions).toBeUndefined();
  });
});

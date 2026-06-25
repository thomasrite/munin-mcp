// Integration test for the Extractor.
//
// Uses a stub LLMProvider so we don't burn API tokens per test invocation.
// The stub returns canned outputs to exercise:
//   - happy-path extraction with provenance + verbatim confidence
//   - validation failure → repair → success
//   - validation failure → repair → still-failing → skip
//   - no tool_use block → no-tool-call outcome
//   - extractor_versions upsert idempotency across calls
//   - confidence = 1.0 when values are verbatim; null otherwise

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sampleConfiguration } from '../test-support/sample-configuration';

import { runMigrations } from '../db/migrate';
import { documents, entities, extractorVersions, paragraphs, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type ParagraphId,
  asActorId,
  asTenantId,
  newDocumentId,
  newParagraphId,
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

import { Extractor } from './extractor';
import { EXTRACTION_TOOL_NAME } from './prompt-assembly';

const TENANT = asTenantId('00000000-0000-0000-0000-00000000ee01');
const ACTOR = asActorId('test-actor');

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
let docId: DocumentId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'extractor-int-test' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

beforeEach(async () => {
  // internal_bypass_log is architecturally append-only (migration 0001
  // installs triggers that reject TRUNCATE/DELETE/UPDATE). Tests tolerate
  // accumulation across the suite.
  await db.execute(
    sql`TRUNCATE entities, edges, paragraphs, documents, llm_calls, extractor_versions, audit_events RESTART IDENTITY CASCADE`,
  );
  docId = newDocumentId();
  await store.insertDocument(
    { tenantId: TENANT, actor: ACTOR },
    {
      id: docId,
      title: 'fixture.txt',
      blobStorageUri: 'blob://stub',
      accessTags: ['t:public'],
    },
  );
});

// ---------------------------------------------------------------------------
// Stub LLM provider — returns canned outputs sequentially. Each call reads
// the next planned response.
// ---------------------------------------------------------------------------

interface PlannedResponse {
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly input: Record<string, unknown>;
  }>;
  readonly text?: string;
}

class StubLlmProvider implements LLMProvider {
  readonly id = 'stub';
  readonly capabilities: ProviderCapabilities = {
    promptCaching: true,
    asymmetricEmbeddings: false,
    maxInputTokens: 200_000,
    maxBatchSize: 1,
  };
  readonly defaultModel = 'stub-model';
  callCount = 0;
  private readonly plan: PlannedResponse[];

  constructor(plan: PlannedResponse[]) {
    this.plan = plan;
  }

  async complete(_request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    const planned = this.plan[this.callCount] ?? { toolCalls: [], text: '' };
    this.callCount++;
    await ctx.graphStore.insertLlmCall(
      { tenantId: ctx.tenantId, actor: asActorId('stub-provider') },
      {
        purpose: ctx.purpose,
        modelId: this.defaultModel,
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        latencyMs: 1,
        region: 'stub',
        ...(ctx.extractorVersionId !== undefined
          ? { extractorVersionId: ctx.extractorVersionId }
          : {}),
        ...(ctx.documentId !== undefined ? { documentId: ctx.documentId } : {}),
      },
    );
    return {
      text: planned.text ?? '',
      toolCalls: (planned.toolCalls ?? []).map((c, i) => ({
        id: `tc-${i}`,
        name: c.name,
        input: c.input,
      })),
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      modelId: this.defaultModel,
      stopReason: 'end_turn',
    };
  }
}

// Embedding stub never called by the extractor but required by ProviderBundle.
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'stub';
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 8192,
    maxBatchSize: 100,
  };
  readonly dimensions = 1024;
  readonly modelId = 'stub-embedding';
  async embed(_request: EmbedRequest, _ctx: ProviderCallContext): Promise<EmbedResponse> {
    return { vectors: [], inputTokens: 0, modelId: this.modelId };
  }
}

void StubEmbeddingProvider;

async function insertParagraph(text: string): Promise<ParagraphId> {
  const id = newParagraphId();
  await store.insertParagraphsBulk({ tenantId: TENANT, actor: ACTOR }, [
    { id, documentId: docId, paragraphIndex: 0, text, accessTags: ['t:public'] },
  ]);
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Extractor — happy path', () => {
  it('extracts entities and edges with full provenance, computes verbatim confidence', async () => {
    const llm = new StubLlmProvider([
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: {
              entities: [
                { type: 'Project', properties: { name: 'Atlas' } },
                { type: 'Person', properties: { fullName: 'Sarah Chen' } },
              ],
              relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
            },
          },
        ],
      },
    ]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph(
      'The Atlas project, led by Sarah Chen, kicked off in March.',
    );
    const result = await extractor.extractParagraph(TENANT, paragraphId);

    expect(result.outcome).toBe('extracted');
    expect(result.entitiesWritten).toBe(2);
    expect(result.edgesWritten).toBe(1);
    expect(result.repairUsed).toBe(false);

    const entityRows = await db.select().from(entities).where(eq(entities.tenantId, TENANT));
    expect(entityRows.length).toBe(2);
    for (const row of entityRows) {
      expect(row.sourceKind).toBe('document_extract');
      expect(row.sourceParagraphId).toBe(paragraphId);
      expect(row.sourceDocumentId).toBe(docId);
      expect(row.extractorVersionId).not.toBeNull();
      // Both values appear verbatim in the paragraph → confidence 1.0
      expect(row.confidence).toBe(1);
    }

    const versionRows = await db
      .select()
      .from(extractorVersions)
      .where(eq(extractorVersions.tenantId, TENANT));
    expect(versionRows.length).toBe(1);
  });

  it('is retry-idempotent: re-extracting a paragraph already done by this version skips, no duplicates', async () => {
    // Simulates a graphile-worker job retry: the same paragraph is processed
    // twice by the same extractor version. The first call writes entities; the
    // second must skip rather than write a second copy (v1 has no dedup).
    const plan = {
      toolCalls: [
        {
          name: EXTRACTION_TOOL_NAME,
          input: {
            entities: [{ type: 'Project', properties: { name: 'Atlas' } }],
            relationships: [],
          },
        },
      ],
    };
    const llm = new StubLlmProvider([plan, plan]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph('The Atlas project kicked off in March.');

    const first = await extractor.extractParagraph(TENANT, paragraphId);
    expect(first.outcome).toBe('extracted');
    expect(first.entitiesWritten).toBe(1);

    const second = await extractor.extractParagraph(TENANT, paragraphId);
    expect(second.outcome).toBe('skipped-existing');
    expect(second.entitiesWritten).toBe(0);

    // Exactly one entity total — the retry wrote nothing.
    const entityRows = await db.select().from(entities).where(eq(entities.tenantId, TENANT));
    expect(entityRows.length).toBe(1);
    // And the LLM was only called once — the skip happens before the model call.
    expect(llm.callCount).toBe(1);
  });

  it('extractor_versions upsert is idempotent across calls', async () => {
    const llm = new StubLlmProvider([
      { toolCalls: [{ name: EXTRACTION_TOOL_NAME, input: { entities: [], relationships: [] } }] },
      { toolCalls: [{ name: EXTRACTION_TOOL_NAME, input: { entities: [], relationships: [] } }] },
    ]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const p1 = await insertParagraph('First paragraph.');
    const p2 = await insertParagraph('Second paragraph.');
    await extractor.extractParagraph(TENANT, p1);
    await extractor.extractParagraph(TENANT, p2);

    const versionRows = await db
      .select()
      .from(extractorVersions)
      .where(eq(extractorVersions.tenantId, TENANT));
    expect(versionRows.length).toBe(1);
  });

  it('confidence is null when extracted values are not verbatim', async () => {
    const llm = new StubLlmProvider([
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: {
              entities: [
                {
                  type: 'Project',
                  properties: {
                    name: 'Project Apollo',
                    description: 'a synthesised name not in the source',
                  },
                },
              ],
              relationships: [],
            },
          },
        ],
      },
    ]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph('The team kicked off a new effort last month.');
    const result = await extractor.extractParagraph(TENANT, paragraphId);
    expect(result.outcome).toBe('extracted');
    const rows = await db.select().from(entities).where(eq(entities.tenantId, TENANT));
    expect(rows[0]?.confidence).toBeNull();
  });
});

describe('Extractor — repair retry', () => {
  it('succeeds on repair when the first call has invalid output', async () => {
    const llm = new StubLlmProvider([
      // First call: invalid entity type.
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: {
              entities: [{ type: 'NotARealType', properties: { foo: 'bar' } }],
              relationships: [],
            },
          },
        ],
      },
      // Repair: valid output.
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: {
              entities: [{ type: 'Project', properties: { name: 'Atlas' } }],
              relationships: [],
            },
          },
        ],
      },
    ]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph('The Atlas project.');
    const result = await extractor.extractParagraph(TENANT, paragraphId);
    expect(result.outcome).toBe('extracted');
    expect(result.repairUsed).toBe(true);
    expect(result.entitiesWritten).toBe(1);
    expect(llm.callCount).toBe(2);
  });

  it('skips paragraph when repair also fails', async () => {
    const llm = new StubLlmProvider([
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: { entities: [{ type: 'Nope', properties: {} }], relationships: [] },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: { entities: [{ type: 'StillNope', properties: {} }], relationships: [] },
          },
        ],
      },
    ]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph('Something.');
    const result = await extractor.extractParagraph(TENANT, paragraphId);
    expect(result.outcome).toBe('validation-failed');
    expect(result.repairUsed).toBe(true);
    const rows = await db.select().from(entities).where(eq(entities.tenantId, TENANT));
    expect(rows.length).toBe(0);
  });
});

describe('Extractor — no tool call', () => {
  it('treats missing tool_use as a clean empty extraction', async () => {
    const llm = new StubLlmProvider([{ text: 'No entities to extract here.', toolCalls: [] }]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph('The end of section.');
    const result = await extractor.extractParagraph(TENANT, paragraphId);
    expect(result.outcome).toBe('no-tool-call');
    expect(result.entitiesWritten).toBe(0);
    expect(llm.callCount).toBe(1);
  });
});

describe('Extractor — llm_calls telemetry', () => {
  it('records llm_calls rows with purpose, extractor_version_id, and document_id', async () => {
    const llm = new StubLlmProvider([
      {
        toolCalls: [
          {
            name: EXTRACTION_TOOL_NAME,
            input: { entities: [], relationships: [] },
          },
        ],
      },
    ]);
    const extractor = new Extractor({
      graphStore: store,
      llmProvider: llm,
      configuration: sampleConfiguration,
    });
    const paragraphId = await insertParagraph('A paragraph.');
    await extractor.extractParagraph(TENANT, paragraphId);

    const rows = await db.execute(
      sql`SELECT purpose, extractor_version_id, document_id FROM llm_calls WHERE tenant_id = ${TENANT}`,
    );
    const list = rows as unknown as Array<{
      purpose: string;
      extractor_version_id: string | null;
      document_id: string | null;
    }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.purpose === 'extraction')).toBe(true);
    expect(list.every((r) => r.extractor_version_id !== null)).toBe(true);
    expect(list.every((r) => r.document_id === docId)).toBe(true);
  });
});

void documents;
void paragraphs;

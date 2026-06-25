// Backend parity (P0): the SAME permission / no-leak assertions must hold
// IDENTICALLY whether the GraphStore is backed by node-postgres (hosted) or
// PGlite (the local/desktop runtime — Postgres compiled to WASM, in-process).
//
// This is the headline parity proof for P1: the local runtime reuses the
// unchanged PostgresGraphStore, so its P0 guarantees must be MEASURED on PGlite,
// not asserted. One shared assertion body runs over a backend matrix — no fork,
// no second permission path. It covers the core of the permission matrix
// (access-tag filter dimensions, cross-tenant isolation, vector + keyword search
// no-leak, bypass logging) AND the query-pipeline end-to-end no-leak (the
// query-leak crown jewel), plus a CRUD/vector smoke.
//
// PGlite runs IN-PROCESS — no Docker. The Postgres backend uses testcontainers
// and is therefore included only when a Docker runtime is reachable; when it is
// not, the PGlite backend still proves the assertions. (Run the file alone to
// exercise PGlite without Docker; run the full int suite with Docker for both.)

import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { internalBypassLog, tenants } from '../db/schema';
import { EXTRACTION_TOOL_NAME } from '../extract';
import { createPgliteGraphStore } from '../graph/pglite-graph-store';
import type { PostgresGraphStore } from '../graph/postgres-graph-store';
import {
  type DocumentId,
  type EntityId,
  type ExtractorVersionId,
  type ParagraphId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asTenantId,
  internalBypass,
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
import { ANSWER_TOOL_NAME } from '../query';
import { QueryPipeline } from '../query/query-pipeline';

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000a1');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000b2');
const ACTOR = asActorId('backend-parity');
const MODEL = 'parity-model';
const SECRET_CANARY = 'ninety thousand pounds';

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};
const constantVector = new Array<number>(1024).fill(1 / Math.sqrt(1024));

async function recordCall(
  ctx: ProviderCallContext,
  modelId: string,
  purpose: ProviderCallContext['purpose'],
): Promise<void> {
  await ctx.graphStore.insertLlmCall(
    { tenantId: ctx.tenantId, actor: asActorId('stub') },
    {
      purpose,
      modelId,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      latencyMs: 1,
      region: 'stub',
    },
  );
}

const embeddingStub: EmbeddingProvider = {
  id: 'stub-embed',
  capabilities: CAPS,
  dimensions: 1024,
  modelId: MODEL,
  async embed(req: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse> {
    await recordCall(ctx, MODEL, 'embedding');
    return { vectors: req.texts.map(() => constantVector), inputTokens: 1, modelId: MODEL };
  },
};

function firstSourceQuote(message: string): { sourceId: string; quote: string } | null {
  const m = message.match(/<source id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/source>/);
  if (!m) return null;
  return { sourceId: m[1]!, quote: m[2]!.trim().split(/\s+/).slice(0, 6).join(' ') };
}

function toolResp(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    text: '',
    toolCalls: name ? [{ id: 't1', name, input }] : [],
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    modelId: 'stub-model',
    stopReason: 'tool_use',
  };
}

const llmStub: LLMProvider = {
  id: 'stub-llm',
  capabilities: CAPS,
  defaultModel: 'stub-model',
  async complete(req: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    await recordCall(ctx, 'stub-model', ctx.purpose);
    const tool = req.toolChoice?.name;
    if (tool === EXTRACTION_TOOL_NAME)
      return toolResp(EXTRACTION_TOOL_NAME, { entities: [], relationships: [] });
    if (tool === ANSWER_TOOL_NAME) {
      const src = firstSourceQuote(req.messages.map((m) => m.content).join('\n'));
      if (!src)
        return toolResp(ANSWER_TOOL_NAME, { status: 'no_evidence', answer: 'none', citations: [] });
      return toolResp(ANSWER_TOOL_NAME, {
        status: 'answered',
        answer: 'Answer [1].',
        citations: [{ marker: 1, sourceId: src.sourceId, quote: src.quote }],
      });
    }
    return toolResp('', {});
  },
};

// ---- Backend matrix -------------------------------------------------------

interface BackendHandle {
  readonly store: PostgresGraphStore;
  // reason: the two drivers' Drizzle handles differ structurally; the parity body
  // only uses the driver-agnostic db.execute/insert/select, so a permissive type
  // keeps the harness uniform across backends.
  // biome-ignore lint/suspicious/noExplicitAny: cross-driver test harness handle (see above)
  readonly db: any;
  close: () => Promise<void>;
}

interface Backend {
  readonly name: string;
  create(): Promise<BackendHandle>;
}

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const pgliteBackend: Backend = {
  name: 'pglite',
  async create() {
    const h = await createPgliteGraphStore({}); // in-memory
    return { store: h.store, db: h.db, close: h.close };
  },
};

const postgresBackend: Backend = {
  name: 'postgres',
  async create() {
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
      'pgvector/pgvector:pg17',
    ).start();
    await runMigrations(container.getConnectionUri());
    const client = postgres(container.getConnectionUri(), { max: 5 });
    const db = drizzle(client);
    const { PostgresGraphStore } = await import('../graph/postgres-graph-store');
    return {
      store: new PostgresGraphStore(db),
      db,
      close: async () => {
        await client.end({ timeout: 5 });
        await container.stop();
      },
    };
  },
};

// PGlite always; Postgres only when a Docker runtime is reachable.
const BACKENDS: Backend[] = [pgliteBackend, ...(dockerAvailable() ? [postgresBackend] : [])];

describe.each(BACKENDS)('GraphStore P0 parity [$name]', (backend) => {
  let handle: BackendHandle;
  const writeCtx = (t: TenantId): WriteContext => ({ tenantId: t, actor: ACTOR });
  const regular = (t: TenantId, tags: readonly string[]): ReadContext => ({
    kind: 'regular',
    tenantId: t,
    accessTags: tags,
    actor: ACTOR,
  });

  let docSecret: DocumentId;
  let paraPub: ParagraphId;
  let paraSecret: ParagraphId;
  let pubEntity: EntityId;
  let secretEntity: EntityId;

  beforeAll(async () => {
    handle = await backend.create();
    await handle.db.insert(tenants).values([
      { id: TENANT_A, name: 'A' },
      { id: TENANT_B, name: 'B' },
    ]);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE entities, edges, paragraphs, documents, embeddings,
      extractor_versions, audit_events, llm_calls, connector_state RESTART IDENTITY CASCADE`);
    const ctx = writeCtx(TENANT_A);
    const store = handle.store;

    const docPub = (
      await store.insertDocument(ctx, {
        title: 'public',
        blobStorageUri: 'b://p',
        accessTags: ['t:pub'],
      })
    ).id;
    docSecret = (
      await store.insertDocument(ctx, {
        title: 'secret',
        blobStorageUri: 'b://s',
        accessTags: ['t:secret'],
      })
    ).id;
    paraPub = (
      await store.insertParagraphsBulk(ctx, [
        {
          documentId: docPub,
          paragraphIndex: 0,
          text: 'Project Apollo ships in the third quarter.',
          accessTags: ['t:pub'],
        },
      ])
    )[0]!.id;
    paraSecret = (
      await store.insertParagraphsBulk(ctx, [
        {
          documentId: docSecret,
          paragraphIndex: 0,
          text: `The Apollo budget is ${SECRET_CANARY}.`,
          accessTags: ['t:secret'],
        },
      ])
    )[0]!.id;
    const ext = (
      await store.upsertExtractorVersion(ctx, {
        configurationId: 'cfg',
        configurationVersion: '0.1.0',
        schemaHash: 'h',
        promptHash: 'p',
        modelId: MODEL,
      })
    ).id as ExtractorVersionId;
    const prov = (para: ParagraphId, doc: DocumentId) => ({
      kind: 'document_extract' as const,
      documentId: doc,
      paragraphId: para,
      extractorVersionId: ext,
      confidence: 1,
    });
    pubEntity = (
      await store.insertEntity(ctx, {
        type: 'Project',
        properties: { name: 'Apollo' },
        accessTags: ['t:pub'],
        provenance: prov(paraPub, docPub),
      })
    ).id;
    secretEntity = (
      await store.insertEntity(ctx, {
        type: 'Budget',
        properties: { name: 'Apollo budget' },
        accessTags: ['t:secret'],
        provenance: prov(paraSecret, docSecret),
      })
    ).id;
    // Edge pub→secret (pub-tagged) so a pub caller's expansion REACHES the secret
    // entity — the triple-filter must still drop it.
    await store.insertEdge(ctx, {
      type: 'relates_to',
      fromEntityId: pubEntity,
      toEntityId: secretEntity,
      accessTags: ['t:pub'],
      provenance: prov(paraPub, docPub),
    });
    await store.upsertEmbedding(ctx, {
      targetKind: 'paragraph',
      targetId: paraPub,
      modelId: MODEL,
      vector: constantVector,
    });
    await store.upsertEmbedding(ctx, {
      targetKind: 'paragraph',
      targetId: paraSecret,
      modelId: MODEL,
      vector: constantVector,
    });
  });

  it('access-tag filter: matching tag sees it; non-matching and EMPTY set see nothing (fail-closed)', async () => {
    expect(await handle.store.getEntity(regular(TENANT_A, ['t:pub']), pubEntity)).not.toBeNull();
    expect(await handle.store.getEntity(regular(TENANT_A, ['t:secret']), pubEntity)).toBeNull();
    expect(await handle.store.getEntity(regular(TENANT_A, []), pubEntity)).toBeNull();
    // a pub caller cannot read the secret entity directly
    expect(await handle.store.getEntity(regular(TENANT_A, ['t:pub']), secretEntity)).toBeNull();
  });

  it('cross-tenant isolation: tenant B cannot read tenant A rows even with the same tags', async () => {
    expect(await handle.store.getEntity(regular(TENANT_B, ['t:pub']), pubEntity)).toBeNull();
    expect(await handle.store.getDocument(regular(TENANT_B, ['t:secret']), docSecret)).toBeNull();
  });

  it('vector search no-leak: a pub caller never gets the secret paragraph embedding', async () => {
    const hits = await handle.store.searchByVector(regular(TENANT_A, ['t:pub']), {
      modelId: MODEL,
      k: 10,
      queryVector: constantVector,
    });
    const ids = hits.map((h) => h.targetId);
    expect(ids).toContain(paraPub);
    expect(ids).not.toContain(paraSecret);
  });

  it('cross-tenant vector isolation (vec2text / OWASP LLM08): byte-identical vectors never cross tenants', async () => {
    // Embeddings are NOT anonymisation — a vector can be inverted back toward its
    // source text (vec2text inversion; OWASP LLM08 sensitive-information-disclosure).
    // So the vector index MUST stay tenant-partitioned even when two tenants store
    // BYTE-IDENTICAL vectors. Insert the same vector under tenant B (with the same
    // access tag tenant A uses — only the tenant differs) and prove A's search
    // never surfaces it, and B's never surfaces A's.
    const ctxB = writeCtx(TENANT_B);
    const docB = (
      await handle.store.insertDocument(ctxB, {
        title: 'tenant-B doc',
        blobStorageUri: 'b://tenantB',
        accessTags: ['t:pub'],
      })
    ).id;
    const paraB = (
      await handle.store.insertParagraphsBulk(ctxB, [
        {
          documentId: docB,
          paragraphIndex: 0,
          text: 'Tenant B paragraph carrying an identical embedding vector.',
          accessTags: ['t:pub'],
        },
      ])
    )[0]!.id;
    await handle.store.upsertEmbedding(ctxB, {
      targetKind: 'paragraph',
      targetId: paraB,
      modelId: MODEL,
      vector: constantVector, // byte-identical to tenant A's vectors
    });

    // Tenant A searches with A's tag and the identical query vector.
    const hitsA = await handle.store.searchByVector(regular(TENANT_A, ['t:pub']), {
      modelId: MODEL,
      k: 10,
      queryVector: constantVector,
    });
    const idsA = hitsA.map((h) => h.targetId);
    expect(idsA).toContain(paraPub); // sees its own
    expect(idsA).not.toContain(paraB); // never tenant B's, despite the identical vector

    // Symmetrically, tenant B sees only its own row, never tenant A's.
    const hitsB = await handle.store.searchByVector(regular(TENANT_B, ['t:pub']), {
      modelId: MODEL,
      k: 10,
      queryVector: constantVector,
    });
    const idsB = hitsB.map((h) => h.targetId);
    expect(idsB).toContain(paraB);
    expect(idsB).not.toContain(paraPub);
  });

  it('keyword search no-leak: a pub caller never gets the secret paragraph', async () => {
    const hits = await handle.store.searchByKeyword(regular(TENANT_A, ['t:pub']), {
      query: 'Apollo',
      k: 10,
    });
    const ids = hits.map((h) => h.targetId);
    expect(ids).toContain(paraPub);
    expect(ids).not.toContain(paraSecret);
  });

  it('query pipeline end-to-end: a pub caller never cites or quotes restricted content', async () => {
    const pipeline = new QueryPipeline({
      graphStore: handle.store,
      llmProvider: llmStub,
      embeddingProvider: embeddingStub,
    });
    const result = await pipeline.answer({
      tenantId: TENANT_A,
      accessTags: ['t:pub'],
      question: 'What about the Apollo budget?',
    });
    expect(result.citations.every((c) => c.documentId !== docSecret)).toBe(true);
    expect(result.citations.every((c) => c.paragraphId !== paraSecret)).toBe(true);
    expect(result.answer).not.toContain(SECRET_CANARY);
  });

  it('bypass read writes one internal_bypass_log row (PL/pgSQL append-only path)', async () => {
    const before = await handle.db.select().from(internalBypassLog);
    const bypassCtx: ReadContext = {
      kind: 'bypass',
      tenantId: TENANT_A,
      bypass: internalBypass('backend-parity', 'verify bypass logging parity'),
      actor: ACTOR,
    };
    // pub-clearance would be denied; bypass drops the access filter (not tenant).
    const secret = await handle.store.getEntity(bypassCtx, secretEntity);
    expect(secret).not.toBeNull();
    const after = await handle.db.select().from(internalBypassLog);
    expect(after.length).toBe(before.length + 1);
  });
});

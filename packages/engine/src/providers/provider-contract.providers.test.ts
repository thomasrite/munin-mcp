// Provider contract suite — runs against real Anthropic + OpenAI APIs.
//
// Gated behind `pnpm test:providers` (the default `pnpm test` excludes
// `*.providers.test.ts`). Spends a few cents per run, so we keep the tests
// short and assert structural behaviour, not output content.
//
// Phase 5 (session 5.1b) adds Bedrock implementations and runs them through
// this exact same suite to verify behavioural equivalence.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate';
import { llmCalls, tenants } from '../db/schema';
import { PostgresGraphStore } from '../graph/postgres-graph-store';
import { asActorId, asTenantId } from '../graph/types';
import { AnthropicLLMProvider, OpenAIEmbeddingProvider, type ProviderCallContext } from './index';

const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();
const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
const TENANT = asTenantId('00000000-0000-0000-0000-000000000099');
const ACTOR = asActorId('contract-test');

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  await db.insert(tenants).values({ id: TENANT, name: 'contract-test' });
}, 180_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (container) await container.stop();
});

const ctx = (): ProviderCallContext => ({
  tenantId: TENANT,
  purpose: 'other',
  graphStore: store,
});

describe.skipIf(!hasAnthropic)('AnthropicLLMProvider — contract', () => {
  const provider = new AnthropicLLMProvider({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    defaultModel: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-4-6',
  });

  it('returns non-empty text and positive token counts for a simple completion', async () => {
    const before = await llmCallCount();
    const response = await provider.complete(
      {
        system: 'You answer in exactly one word.',
        messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
        maxOutputTokens: 16,
      },
      ctx(),
    );
    expect(response.text.trim().length).toBeGreaterThan(0);
    expect(response.inputTokens).toBeGreaterThan(0);
    expect(response.outputTokens).toBeGreaterThan(0);
    expect(response.modelId).toMatch(/claude/);
    expect(await llmCallCount()).toBe(before + 1);
  });

  it('reports stopReason as a known value', async () => {
    const response = await provider.complete(
      {
        system: 'Reply briefly.',
        messages: [{ role: 'user', content: 'Say hi.' }],
        maxOutputTokens: 8,
      },
      ctx(),
    );
    expect(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'other']).toContain(
      response.stopReason,
    );
  });

  it('exposes capabilities.promptCaching === true', () => {
    expect(provider.capabilities.promptCaching).toBe(true);
  });

  // Empirical: confirm prompt caching actually works against the live API.
  // Two calls with identical large cacheable prefix → second one shows
  // cache_read_input_tokens > 0. A third call with modified system → cache
  // miss (no read). Spend: ~£0.02 per run.
  it('cache hits on repeated identical prefix; misses after content change', async () => {
    // Construct a system prompt large enough to clear Anthropic's 1024-token
    // minimum cacheable size. Repetition keeps the test deterministic.
    const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(200);
    const systemA = `You answer in one word.\n\nReference material (ignored):\n${filler}`;
    const systemB = `You answer in one word.\n\nDifferent reference:\n${filler}DIFFERENT`;

    const first = await provider.complete(
      {
        system: systemA,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        cacheableSystemPrefix: true,
        maxOutputTokens: 8,
      },
      ctx(),
    );
    // First call: cache creation, no reads.
    expect(first.cachedInputTokens).toBe(0);
    expect(first.inputTokens).toBeGreaterThan(1000);

    // Tiny sleep so the second request goes after the cache is created.
    await new Promise((r) => setTimeout(r, 1500));

    const second = await provider.complete(
      {
        system: systemA,
        messages: [{ role: 'user', content: 'Again, say "ok".' }],
        cacheableSystemPrefix: true,
        maxOutputTokens: 8,
      },
      ctx(),
    );
    // Second call with identical prefix: should hit the cache.
    expect(second.cachedInputTokens).toBeGreaterThan(1000);

    // Third call with modified prefix: different content → no cache hit.
    const third = await provider.complete(
      {
        system: systemB,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        cacheableSystemPrefix: true,
        maxOutputTokens: 8,
      },
      ctx(),
    );
    expect(third.cachedInputTokens).toBe(0);
  }, 60_000);
});

describe.skipIf(!hasOpenAI)('OpenAIEmbeddingProvider — contract', () => {
  const provider = new OpenAIEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    modelId: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    dimensions: 1024,
  });

  it('returns vectors of the declared dimension', async () => {
    const before = await llmCallCount();
    const response = await provider.embed(
      { texts: ['hello world', 'a second paragraph for the contract test'], kind: 'document' },
      ctx(),
    );
    expect(response.vectors).toHaveLength(2);
    for (const v of response.vectors) {
      expect(v).toHaveLength(provider.dimensions);
      for (const n of v) expect(Number.isFinite(n)).toBe(true);
    }
    expect(response.inputTokens).toBeGreaterThan(0);
    expect(await llmCallCount()).toBe(before + 1);
  });

  it('preserves input order in the returned vectors', async () => {
    const inputs = ['first', 'second', 'third'];
    const r1 = await provider.embed({ texts: inputs, kind: 'document' }, ctx());
    const r2 = await provider.embed({ texts: inputs.slice().reverse(), kind: 'document' }, ctx());
    // Trivial: vectors[0] of forward should be close to vectors[2] of reversed.
    const a = r1.vectors[0]!;
    const c = r2.vectors[2]!;
    const cos = cosineSimilarity(a, c);
    expect(cos).toBeGreaterThan(0.999); // identical input → identical-ish output
  });

  it('symmetric provider: query vs document kind produces same embedding', async () => {
    const text = 'the colour of the sky on a clear afternoon';
    const docR = await provider.embed({ texts: [text], kind: 'document' }, ctx());
    const queryR = await provider.embed({ texts: [text], kind: 'query' }, ctx());
    const cos = cosineSimilarity(docR.vectors[0]!, queryR.vectors[0]!);
    expect(cos).toBeGreaterThan(0.999);
  });
});

async function llmCallCount(): Promise<number> {
  const r = await db
    .select({ value: sql<number>`count(*)` })
    .from(llmCalls)
    .where(eq(llmCalls.tenantId, TENANT));
  return Number(r[0]?.value ?? 0);
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Helper to silence the lint warning about unused imports when both providers
// are skipped (e.g. no keys present locally).
void ACTOR;

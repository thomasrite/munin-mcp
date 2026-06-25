import { describe, expect, it, vi } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asTenantId } from '../graph/types';
import { LlmJudgeRerankProvider } from './llm-judge-rerank-provider';
import type { LLMProvider, LLMResponse, ProviderCallContext } from './provider-types';

function ctx(): ProviderCallContext {
  return {
    tenantId: asTenantId('00000000-0000-0000-0000-0000000000aa'),
    purpose: 'query',
    graphStore: { insertLlmCall: async () => {} } as unknown as GraphStoreWriter,
  };
}

// A fake LLM whose tool call returns the given passage ordering.
function fakeLlm(ranking: unknown): { provider: LLMProvider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(
    async (): Promise<LLMResponse> => ({
      text: '',
      toolCalls: [{ id: 't1', name: 'rank', input: { ranking } }],
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      modelId: 'claude-haiku-4-5-20251001',
      stopReason: 'tool_use',
    }),
  );
  const provider = {
    id: 'fake',
    capabilities: {
      promptCaching: false,
      asymmetricEmbeddings: false,
      maxInputTokens: 0,
      maxBatchSize: 1,
    },
    defaultModel: 'claude-haiku-4-5-20251001',
    complete,
  } as unknown as LLMProvider;
  return { provider, complete };
}

const docs = [
  { id: 'a', text: 'about Alex Carter on the Apollo project' },
  { id: 'b', text: 'about Bianca Lowe on the Borealis project' },
  { id: 'c', text: 'about Chen Okafor on the Cosmos project' },
];

describe('LlmJudgeRerankProvider', () => {
  it('re-orders by the model ranking and maps indices back to ids', async () => {
    const { provider } = fakeLlm([2, 0, 1]); // c, a, b
    const r = new LlmJudgeRerankProvider({ llm: provider });
    const res = await r.rerank({ query: 'Chen Okafor', documents: docs, topK: 3 }, ctx());
    expect(res.ranking.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    // scores are strictly descending (used only to order)
    expect(res.ranking[0]!.score).toBeGreaterThan(res.ranking[1]!.score);
  });

  it('caps to topK and drops omitted (irrelevant) passages', async () => {
    const { provider } = fakeLlm([1]); // only b is relevant
    const r = new LlmJudgeRerankProvider({ llm: provider });
    const res = await r.rerank({ query: 'Bianca Lowe', documents: docs, topK: 3 }, ctx());
    expect(res.ranking.map((x) => x.id)).toEqual(['b']);
  });

  it('ignores out-of-range / duplicate indices defensively', async () => {
    const { provider } = fakeLlm([5, 0, 0, -1, 2]); // 5 and -1 invalid, dup 0
    const r = new LlmJudgeRerankProvider({ llm: provider });
    const res = await r.rerank({ query: 'q', documents: docs, topK: 5 }, ctx());
    expect(res.ranking.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('honours topK by truncating the ranking', async () => {
    const { provider } = fakeLlm([0, 1, 2]);
    const r = new LlmJudgeRerankProvider({ llm: provider });
    const res = await r.rerank({ query: 'q', documents: docs, topK: 2 }, ctx());
    expect(res.ranking.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns empty for an empty candidate set without calling the model', async () => {
    const { provider, complete } = fakeLlm([]);
    const r = new LlmJudgeRerankProvider({ llm: provider });
    const res = await r.rerank({ query: 'q', documents: [], topK: 3 }, ctx());
    expect(res.ranking).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});

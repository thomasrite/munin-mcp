import { describe, expect, it, vi } from 'vitest';

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asTenantId } from '../graph/types';
import { BedrockCohereRerankProvider } from './bedrock-cohere-rerank-provider';
import type { ProviderCallContext } from './provider-types';

function ctx(): ProviderCallContext {
  return {
    tenantId: asTenantId('00000000-0000-0000-0000-0000000000aa'),
    purpose: 'query',
    graphStore: { insertLlmCall: async () => {} } as unknown as GraphStoreWriter,
  };
}

// A fake client returning a Cohere-rerank-shaped InvokeModel body.
function fakeClient(results: { index: number; relevance_score: number }[]): BedrockRuntimeClient {
  const send = vi.fn(async () => ({
    body: new TextEncoder().encode(JSON.stringify({ results })),
  }));
  return { send } as unknown as BedrockRuntimeClient;
}

const docs = [
  { id: 'a', text: 'doc a' },
  { id: 'b', text: 'doc b' },
  { id: 'c', text: 'doc c' },
];

describe('BedrockCohereRerankProvider', () => {
  it('maps Cohere results (index + relevance_score) back to ids in order', async () => {
    const provider = new BedrockCohereRerankProvider({
      region: 'eu-west-2',
      modelId: 'cohere.rerank-v3-5:0',
      client: fakeClient([
        { index: 2, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.42 },
      ]),
    });
    const res = await provider.rerank({ query: 'q', documents: docs, topK: 2 }, ctx());
    expect(res.ranking).toEqual([
      { id: 'c', score: 0.91 },
      { id: 'a', score: 0.42 },
    ]);
  });

  it('returns empty for an empty candidate set without a network call', async () => {
    const client = fakeClient([]);
    const provider = new BedrockCohereRerankProvider({
      region: 'eu-west-2',
      modelId: 'cohere.rerank-v3-5:0',
      client,
    });
    const res = await provider.rerank({ query: 'q', documents: [], topK: 3 }, ctx());
    expect(res.ranking).toEqual([]);
  });
});

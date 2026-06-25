import { describe, expect, it, vi } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asTenantId } from '../graph/types';
import type { NewLlmCall } from '../graph/types';
import { HttpCrossEncoderRerankProvider } from './http-cross-encoder-rerank-provider';
import type { ProviderCallContext } from './provider-types';

function ctxWithCapture(): { ctx: ProviderCallContext; calls: NewLlmCall[] } {
  const calls: NewLlmCall[] = [];
  const graphStore = {
    async insertLlmCall(_c: unknown, params: NewLlmCall): Promise<void> {
      calls.push(params);
    },
  } as unknown as GraphStoreWriter;
  return {
    ctx: {
      tenantId: asTenantId('00000000-0000-0000-0000-000000000001'),
      purpose: 'query',
      graphStore,
    },
    calls,
  };
}

// A fake fetch returning a TEI-shaped /rerank response (sorted, {index, score}).
function fakeFetch(items: Array<{ index: number; score: number }>, captured?: { body?: unknown }) {
  return (async (_url: string, init?: RequestInit) => {
    if (captured && init?.body) captured.body = JSON.parse(String(init.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return items;
      },
    } as Response;
  }) as unknown as typeof fetch;
}

const DOCS = [
  { id: 'A', text: 'alpha' },
  { id: 'B', text: 'bravo' },
  { id: 'C', text: 'charlie' },
];

describe('HttpCrossEncoderRerankProvider', () => {
  it('maps the endpoint ranking (index → id) and honours topK', async () => {
    // Endpoint says C is most relevant, then A, then B.
    const provider = new HttpCrossEncoderRerankProvider({
      endpoint: 'http://x/rerank',
      modelId: 'BAAI/bge-reranker-v2-m3',
      fetchImpl: fakeFetch([
        { index: 2, score: 0.9 },
        { index: 0, score: 0.5 },
        { index: 1, score: 0.1 },
      ]),
    });
    const { ctx } = ctxWithCapture();
    const res = await provider.rerank({ query: 'q', documents: DOCS, topK: 2 }, ctx);
    expect(res.modelId).toBe('BAAI/bge-reranker-v2-m3');
    expect(res.ranking.map((r) => r.id)).toEqual(['C', 'A']); // topK=2, in ranked order
    expect(res.ranking[0]?.score).toBe(0.9);
  });

  it('only sends the caller-supplied (permission-filtered) documents to the endpoint', async () => {
    const captured: { body?: unknown } = {};
    const provider = new HttpCrossEncoderRerankProvider({
      endpoint: 'http://x/rerank',
      modelId: 'm',
      fetchImpl: fakeFetch([{ index: 0, score: 1 }], captured),
    });
    const { ctx } = ctxWithCapture();
    await provider.rerank({ query: 'who?', documents: DOCS, topK: 3 }, ctx);
    // The body carries ONLY the texts it was handed — it never fetches more.
    expect(captured.body).toEqual({
      query: 'who?',
      texts: ['alpha', 'bravo', 'charlie'],
      truncate: true,
    });
  });

  it('records a £0 (zero-token) local telemetry row with rerank latency', async () => {
    const provider = new HttpCrossEncoderRerankProvider({
      endpoint: 'http://x/rerank',
      modelId: 'BAAI/bge-reranker-v2-m3',
      fetchImpl: fakeFetch([{ index: 0, score: 1 }]),
    });
    const { ctx, calls } = ctxWithCapture();
    await provider.rerank({ query: 'q', documents: DOCS, topK: 3 }, ctx);
    expect(calls).toHaveLength(1);
    const row = calls[0]!;
    expect(row.purpose).toBe('other');
    expect(row.region).toBe('local'); // UK/local — never US/Frankfurt
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0); // £0 by construction
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row.metadata).toMatchObject({ rerank: true, candidates: 3 });
  });

  it('ignores out-of-range / duplicate indices defensively', async () => {
    const provider = new HttpCrossEncoderRerankProvider({
      endpoint: 'http://x/rerank',
      modelId: 'm',
      fetchImpl: fakeFetch([
        { index: 99, score: 1 }, // out of range → skipped
        { index: 1, score: 0.8 },
        { index: 1, score: 0.7 }, // duplicate → skipped
      ]),
    });
    const { ctx } = ctxWithCapture();
    const res = await provider.rerank({ query: 'q', documents: DOCS, topK: 3 }, ctx);
    expect(res.ranking.map((r) => r.id)).toEqual(['B']);
  });

  it('returns empty for an empty candidate set without calling the endpoint', async () => {
    const spy = vi.fn();
    const provider = new HttpCrossEncoderRerankProvider({
      endpoint: 'http://x/rerank',
      modelId: 'm',
      fetchImpl: spy as unknown as typeof fetch,
    });
    const { ctx } = ctxWithCapture();
    const res = await provider.rerank({ query: 'q', documents: [], topK: 5 }, ctx);
    expect(res.ranking).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws a ProviderError (and records a failed row) on a non-OK response', async () => {
    const provider = new HttpCrossEncoderRerankProvider({
      endpoint: 'http://x/rerank',
      modelId: 'm',
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 503,
          async json() {
            return {};
          },
        }) as Response) as unknown as typeof fetch,
    });
    const { ctx, calls } = ctxWithCapture();
    await expect(provider.rerank({ query: 'q', documents: DOCS, topK: 3 }, ctx)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(calls[0]?.failed).toBe(true);
  });
});

// Unit tests for the Ollama local providers (P1) — mocked fetch, no daemon, no
// network. Assert request shape, response mapping, region:'local' telemetry, the
// tool-call mapping, and the 1024-dim embedding fail-fast.

import { describe, expect, it, vi } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { type NewLlmCall, asTenantId } from '../graph/types';
import { OllamaEmbeddingProvider } from './ollama-embedding-provider';
import { OllamaLLMProvider } from './ollama-llm-provider';
import { ProviderError, ProviderUnavailableError } from './provider-errors';
import type { ProviderCallContext } from './provider-types';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000a1');

function makeCtx(): { ctx: ProviderCallContext; calls: NewLlmCall[] } {
  const calls: NewLlmCall[] = [];
  const graphStore = {
    insertLlmCall: async (_w: unknown, params: NewLlmCall) => {
      calls.push(params);
    },
  } as unknown as GraphStoreWriter;
  return { ctx: { tenantId: TENANT, purpose: 'query', graphStore }, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OllamaLLMProvider', () => {
  it('POSTs to /api/chat with system-first messages and stream:false; maps the response + region=local', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        model: 'llama3.1',
        message: { content: 'Hello [1].' },
        prompt_eval_count: 10,
        eval_count: 5,
        done_reason: 'stop',
      }),
    );
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434/',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx, calls } = makeCtx();

    const res = await provider.complete(
      { system: 'be terse', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    );

    // request shape
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/chat'); // trailing slash trimmed
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('llama3.1');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });

    // response mapping
    expect(res.text).toBe('Hello [1].');
    expect(res.inputTokens).toBe(10);
    expect(res.outputTokens).toBe(5);
    expect(res.cachedInputTokens).toBe(0);
    expect(res.stopReason).toBe('end_turn');
    expect(res.modelId).toBe('llama3.1');

    // telemetry: region 'local', honest purpose
    expect(calls).toHaveLength(1);
    expect(calls[0]!.region).toBe('local');
    expect(calls[0]!.purpose).toBe('query');
  });

  it('maps Ollama tool_calls to LLMToolCall and reports stopReason=tool_use', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'llama3.1',
        message: {
          content: '',
          tool_calls: [{ function: { name: 'submit_answer', arguments: { status: 'answered' } } }],
        },
        done_reason: 'stop',
      }),
    );
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx } = makeCtx();
    const res = await provider.complete(
      {
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ name: 'submit_answer', description: 'd', inputSchema: { type: 'object' } }],
        toolChoice: { type: 'tool', name: 'submit_answer' },
      },
      ctx,
    );
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.name).toBe('submit_answer');
    expect(res.toolCalls[0]!.input).toEqual({ status: 'answered' });
    expect(res.stopReason).toBe('tool_use');
  });

  it('throws ProviderError on a non-OK response and records a failed telemetry row', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx, calls } = makeCtx();
    await expect(
      provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, ctx),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.failed).toBe(true);
    expect(calls[0]!.region).toBe('local');
  });

  it('wraps a fetch failure (daemon down) as ProviderUnavailableError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx } = makeCtx();
    await expect(
      provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, ctx),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('OllamaEmbeddingProvider', () => {
  it('POSTs to /api/embeddings per text, returns 1024-dim vectors, records region=local', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ embedding: new Array(1024).fill(0.1) }),
    );
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      modelId: 'bge-m3',
      dimensions: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx, calls } = makeCtx();
    const res = await provider.embed({ texts: ['a', 'b'], kind: 'document' }, ctx);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/embeddings');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ model: 'bge-m3', prompt: 'a' });

    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toHaveLength(1024);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.region).toBe('local');
    expect(calls[0]!.purpose).toBe('embedding');
  });

  it('FAILS FAST when the model returns a non-1024 dimension', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ embedding: new Array(768).fill(0.1) }));
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      modelId: 'wrong-model',
      dimensions: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx, calls } = makeCtx();
    await expect(provider.embed({ texts: ['a'], kind: 'document' }, ctx)).rejects.toThrow(
      /768 dims, expected 1024/,
    );
    // a failed telemetry row is still recorded
    expect(calls.at(-1)!.failed).toBe(true);
    expect(calls.at(-1)!.region).toBe('local');
  });

  it('returns empty without calling fetch for an empty batch', async () => {
    const fetchImpl = vi.fn();
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      modelId: 'bge-m3',
      dimensions: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx } = makeCtx();
    const res = await provider.embed({ texts: [], kind: 'document' }, ctx);
    expect(res.vectors).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P2-10 — request timeouts. A wedged daemon (socket open, never answering)
// must fail fast with a named timeout, not hang the pipeline forever. The
// mock honours the AbortSignal the provider must attach: it never resolves,
// only rejects when the signal's timeout fires.
// ---------------------------------------------------------------------------

// A fetch that hangs until the provided signal aborts (the wedged daemon).
function wedgedFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal → hang forever (the test would time out)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

describe('Ollama request timeouts (P2-10)', () => {
  it('LLM: a wedged /api/chat fails fast with a named timeout (env-tunable budget)', async () => {
    const fetchImpl = wedgedFetch();
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    const { ctx, calls } = makeCtx();

    await expect(
      provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, ctx),
    ).rejects.toThrow(/timed out after 25ms.*OLLAMA_TIMEOUT_MS/);
    // The hang is still recorded as a failed telemetry row.
    expect(calls.at(-1)!.failed).toBe(true);
  });

  it('LLM: attaches an AbortSignal to the request (the timeout has a mechanism)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ message: { content: 'ok' }, done_reason: 'stop' });
    });
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { ctx } = makeCtx();
    const res = await provider.complete(
      { system: 's', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    );
    expect(res.text).toBe('ok'); // a healthy daemon is unaffected by the budget
  });

  it('embeddings: a wedged /api/embeddings fails fast with a named timeout', async () => {
    const fetchImpl = wedgedFetch();
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      modelId: 'bge-m3',
      dimensions: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    const { ctx, calls } = makeCtx();

    await expect(provider.embed({ texts: ['one'], kind: 'document' }, ctx)).rejects.toThrow(
      /timed out after 25ms.*OLLAMA_TIMEOUT_MS/,
    );
    expect(calls.at(-1)!.failed).toBe(true);
  });

  it('a timeout maps to ProviderError (wedged), not ProviderUnavailableError (down)', async () => {
    const fetchImpl = wedgedFetch();
    const provider = new OllamaLLMProvider({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    const { ctx } = makeCtx();
    const err = await provider
      .complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, ctx)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
  });
});

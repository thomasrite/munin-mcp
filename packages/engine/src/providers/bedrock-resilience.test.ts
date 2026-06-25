// Proves the Bedrock providers can no longer hang: a stalled or transiently
// failing client is timed out, retried with backoff, and a permanent failure
// surfaces a typed error — all with an INJECTED fake client (no network), so the
// resilience layer is exercised directly. The production 10k-embed hang was a
// single Titan call that stalled with no timeout and no retry; these tests are
// the regression guard.

import { describe, expect, it, vi } from 'vitest';

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asTenantId } from '../graph/types';
import { BedrockLLMProvider } from './bedrock-llm-provider';
import { BedrockTitanEmbeddingProvider } from './bedrock-titan-embedding-provider';
import {
  ContextLengthError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from './provider-errors';
import type { ProviderCallContext } from './provider-types';
import { invokeWithResilience, isRetryableBedrockError, mapWithConcurrency } from './resilience';

// Fast policy so the suite runs in milliseconds: 20ms timeout, no real backoff.
const FAST = {
  timeoutMs: 20,
  maxAttempts: 3,
  baseDelayMs: 1,
  sleep: async () => {},
  random: () => 0,
};

function ctx(): ProviderCallContext {
  return {
    tenantId: asTenantId('00000000-0000-0000-0000-0000000000aa'),
    purpose: 'embedding',
    graphStore: { insertLlmCall: async () => {} } as unknown as GraphStoreWriter,
  };
}

// A fake BedrockRuntimeClient whose `send` is the provided spy.
function fakeClient(send: (...args: unknown[]) => unknown): BedrockRuntimeClient {
  return { send } as unknown as BedrockRuntimeClient;
}

// A valid Titan InvokeModel response body (1024-dim unit vector).
function titanOk(): { body: Uint8Array } {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({ embedding: new Array(1024).fill(0.01), inputTextTokenCount: 3 }),
    ),
  };
}

function embedder(send: (...args: unknown[]) => unknown, over: Partial<typeof FAST> = {}) {
  return new BedrockTitanEmbeddingProvider({
    region: 'eu-west-2',
    modelId: 'amazon.titan-embed-text-v2:0',
    dimensions: 1024,
    client: fakeClient(send),
    resilience: { ...FAST, ...over },
    concurrency: 2,
  });
}

describe('Bedrock resilience — embedding provider', () => {
  it('a stalled call times out and surfaces ProviderTimeoutError (cannot hang)', async () => {
    // send never resolves and ignores the abort signal — the worst case.
    const send = vi.fn(() => new Promise(() => {}));
    const provider = embedder(send as never);

    await expect(
      provider.embed({ texts: ['hello'], kind: 'document' }, ctx()),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(send).toHaveBeenCalledTimes(FAST.maxAttempts); // timed out + retried each attempt
  });

  it('retries a transient failure and then succeeds', async () => {
    let n = 0;
    const send = vi.fn(async () => {
      n++;
      if (n < 3) throw { name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } };
      return titanOk();
    });
    const provider = embedder(send as never, { maxAttempts: 4 });

    const res = await provider.embed({ texts: ['hello'], kind: 'document' }, ctx());
    expect(res.vectors[0]?.length).toBe(1024);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('surfaces a typed error after exhausting retries on a permanent 5xx', async () => {
    const send = vi.fn(async () => {
      throw { name: 'InternalServerException', $metadata: { httpStatusCode: 500 } };
    });
    const provider = embedder(send as never);

    await expect(provider.embed({ texts: ['hi'], kind: 'document' }, ctx())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(send).toHaveBeenCalledTimes(FAST.maxAttempts);
  });

  it('does NOT retry a non-transient error (context length) — surfaces at once', async () => {
    const send = vi.fn(async () => {
      throw {
        name: 'ValidationException',
        message: 'input is too long: maximum tokens exceeded',
        $metadata: { httpStatusCode: 400 },
      };
    });
    const provider = embedder(send as never);

    await expect(provider.embed({ texts: ['x'], kind: 'document' }, ctx())).rejects.toBeInstanceOf(
      ContextLengthError,
    );
    expect(send).toHaveBeenCalledTimes(1); // no wasted retries on a permanent error
  });
});

describe('Bedrock resilience — LLM provider', () => {
  it('a stalled Converse call times out (cannot hang)', async () => {
    const send = vi.fn(() => new Promise(() => {}));
    const provider = new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: { sonnet: 'eu.anthropic.claude-sonnet-4-6' },
      client: fakeClient(send as never),
      resilience: FAST,
    });
    await expect(
      provider.complete(
        { system: 's', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 8 },
        { ...ctx(), purpose: 'query' },
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(send).toHaveBeenCalledTimes(FAST.maxAttempts);
  });
});

describe('resilience helpers', () => {
  it('isRetryableBedrockError classifies transient vs permanent', () => {
    expect(isRetryableBedrockError(new ProviderTimeoutError('bedrock', 10))).toBe(true);
    expect(
      isRetryableBedrockError({ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }),
    ).toBe(true);
    expect(isRetryableBedrockError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isRetryableBedrockError({ name: 'ExpiredTokenException' })).toBe(true); // transient auth
    // Node system errors carry the code on `.code`, NOT `.name` (the EADDRNOTAVAIL
    // blip that killed the first 10k scoring pass) — must still be retryable.
    expect(isRetryableBedrockError({ code: 'EADDRNOTAVAIL', syscall: 'read' })).toBe(true);
    expect(isRetryableBedrockError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableBedrockError(new ContextLengthError('bedrock', 9000, 8192))).toBe(false);
    expect(
      isRetryableBedrockError({ name: 'ValidationException', $metadata: { httpStatusCode: 400 } }),
    ).toBe(false);
  });

  it('retries a transient socket error carried on `.code` (EADDRNOTAVAIL)', async () => {
    let n = 0;
    const send = vi.fn(async () => {
      n++;
      if (n < 2) throw { code: 'EADDRNOTAVAIL', syscall: 'read', $metadata: { attempts: 1 } };
      return titanOk();
    });
    const provider = embedder(send as never, { maxAttempts: 3 });
    const res = await provider.embed({ texts: ['hello'], kind: 'document' }, ctx());
    expect(res.vectors[0]?.length).toBe(1024);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('invokeWithResilience returns the value when the call settles in time', async () => {
    const out = await invokeWithResilience(async () => 42, { providerId: 'bedrock', ...FAST });
    expect(out).toBe(42);
  });

  it('mapWithConcurrency preserves order and bounds in-flight calls', async () => {
    let inFlight = 0;
    let peak = 0;
    const fn = async (x: number): Promise<number> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return x * 2;
    };
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, fn);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]); // order preserved
    expect(peak).toBeLessThanOrEqual(3); // bounded
  });
});

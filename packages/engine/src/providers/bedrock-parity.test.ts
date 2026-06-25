import { describe, expect, it } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asTenantId } from '../graph/types';
import type { NewLlmCall } from '../graph/types';
import { BedrockLLMProvider, type BedrockLLMProviderConfig } from './bedrock-llm-provider';
import { BedrockTitanEmbeddingProvider } from './bedrock-titan-embedding-provider';
import { ProviderConfigurationError, ProviderError } from './provider-errors';
import { loadEmbeddingProvider, loadLlmProvider } from './provider-factory';
import type { LLMTool, ProviderCallContext } from './provider-types';

// The provider's injected-client type, referenced via the provider's own config
// — NOT by importing the AWS SDK here. The SDK import stays confined to the two
// provider impl files (the /engine-audit rule). Canned API outputs are plain
// objects (only the fields the providers read matter).
type FakeClient = NonNullable<BedrockLLMProviderConfig['client']>;
type FakeOutput = Record<string, unknown>;

// Parity tests for the Bedrock providers — mocked client, no network. They lock
// the LLMRequest → Converse mapping, cachePoint placement, response/usage
// parsing, model mapping, and the Titan embed shape. The live path is a separate
// gated test (bedrock-live.providers.test.ts, run via `pnpm test:providers`).

function fakeCallContext(): {
  ctx: ProviderCallContext;
  calls: NewLlmCall[];
} {
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

// A fake BedrockRuntimeClient that records every command's `.input` and returns
// a canned output.
function fakeClient(output: unknown): {
  client: FakeClient;
  sent: Array<{ input: Record<string, unknown> }>;
} {
  const sent: Array<{ input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { input: Record<string, unknown> }): Promise<unknown> {
      sent.push(command);
      return output;
    },
  } as unknown as FakeClient;
  return { client, sent };
}

const PROFILES = { opus: 'eu.opus.v1', sonnet: 'eu.sonnet.v1', haiku: 'eu.haiku.v1' };

function converseOutput(over?: FakeOutput): FakeOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [
          { text: 'here you go' },
          { toolUse: { toolUseId: 't1', name: 'extract', input: { entities: [] } } },
        ],
      },
    },
    stopReason: 'tool_use',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 10,
    },
    ...over,
  };
}

const extractTool: LLMTool = {
  name: 'extract',
  description: 'extract entities',
  inputSchema: { type: 'object', properties: { entities: { type: 'array' } } },
};

describe('BedrockLLMProvider — model mapping', () => {
  it('maps canonical families to the configured eu inference-profile id (wire modelId)', async () => {
    for (const [model, expected] of [
      ['claude-sonnet-4-6', 'eu.sonnet.v1'],
      ['claude-opus-4-7', 'eu.opus.v1'],
      ['claude-haiku-4-5-20251001', 'eu.haiku.v1'],
    ] as const) {
      const { client, sent } = fakeClient(converseOutput());
      const provider = new BedrockLLMProvider({
        region: 'eu-west-2',
        defaultModel: 'claude-sonnet-4-6',
        modelProfiles: PROFILES,
        client,
      });
      const { ctx } = fakeCallContext();
      await provider.complete({ model, system: 's', messages: [] }, ctx);
      expect(sent[0]?.input.modelId).toBe(expected);
    }
  });

  it('defaults to the sonnet family when no model is requested', async () => {
    const { client, sent } = fakeClient(converseOutput());
    const provider = new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: PROFILES,
      client,
    });
    const { ctx } = fakeCallContext();
    await provider.complete({ system: 's', messages: [] }, ctx);
    expect(sent[0]?.input.modelId).toBe('eu.sonnet.v1');
  });

  it('throws ProviderConfigurationError when the requested family has no profile', async () => {
    const { client } = fakeClient(converseOutput());
    const provider = new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: { sonnet: 'eu.sonnet.v1' }, // no opus
      client,
    });
    const { ctx } = fakeCallContext();
    await expect(
      provider.complete({ model: 'claude-opus-4-7', system: 's', messages: [] }, ctx),
    ).rejects.toBeInstanceOf(ProviderConfigurationError);
  });
});

describe('BedrockLLMProvider — request shaping + cachePoint parity', () => {
  function makeProvider(client: FakeClient) {
    return new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: PROFILES,
      client,
    });
  }

  it('shapes system, messages, and tool_use into the Converse format', async () => {
    const { client, sent } = fakeClient(converseOutput());
    const { ctx } = fakeCallContext();
    await makeProvider(client).complete(
      {
        system: 'system prompt',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [extractTool],
        toolChoice: { type: 'tool', name: 'extract' },
      },
      ctx,
    );
    const input = sent[0]?.input as {
      system: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: Array<{ text?: string }> }>;
      toolConfig: { tools: Array<Record<string, unknown>>; toolChoice: Record<string, unknown> };
    };
    expect(input.system[0]).toEqual({ text: 'system prompt' });
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
    expect(input.toolConfig.tools[0]).toEqual({
      toolSpec: {
        name: 'extract',
        description: 'extract entities',
        inputSchema: { json: extractTool.inputSchema },
      },
    });
    expect(input.toolConfig.toolChoice).toEqual({ tool: { name: 'extract' } });
  });

  it('places a cachePoint AFTER the system content and AFTER the tools array when cacheableSystemPrefix', async () => {
    const { client, sent } = fakeClient(converseOutput());
    const { ctx } = fakeCallContext();
    await makeProvider(client).complete(
      {
        system: 'sys',
        messages: [{ role: 'user', content: 'x' }],
        tools: [extractTool],
        toolChoice: { type: 'tool', name: 'extract' },
        cacheableSystemPrefix: true,
      },
      ctx,
    );
    const input = sent[0]?.input as {
      system: Array<Record<string, unknown>>;
      toolConfig: { tools: Array<Record<string, unknown>> };
    };
    // system: [ {text}, {cachePoint} ]
    expect(input.system).toHaveLength(2);
    expect(input.system[1]).toEqual({ cachePoint: { type: 'default' } });
    // tools: [ toolSpec, {cachePoint} ] — cachePoint is the LAST element.
    const tools = input.toolConfig.tools;
    expect(tools[tools.length - 1]).toEqual({ cachePoint: { type: 'default' } });
  });

  it('emits no cachePoint when cacheableSystemPrefix is absent', async () => {
    const { client, sent } = fakeClient(converseOutput());
    const { ctx } = fakeCallContext();
    await makeProvider(client).complete(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }], tools: [extractTool] },
      ctx,
    );
    const input = sent[0]?.input as {
      system: Array<Record<string, unknown>>;
      toolConfig: { tools: Array<Record<string, unknown>> };
    };
    expect(input.system).toHaveLength(1);
    expect(input.toolConfig.tools.every((t) => !('cachePoint' in t))).toBe(true);
  });
});

describe('BedrockLLMProvider — response + usage parsing + telemetry', () => {
  it('parses text, tool calls, token usage, and records eu-west-2 telemetry with the canonical model id', async () => {
    const { client } = fakeClient(converseOutput());
    const provider = new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: PROFILES,
      client,
    });
    const { ctx, calls } = fakeCallContext();
    const res = await provider.complete({ system: 's', messages: [], tools: [extractTool] }, ctx);

    expect(res.text).toBe('here you go');
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'extract', input: { entities: [] } }]);
    // inputTokens = regular(100) + cacheWrite(10); cachedInputTokens = cacheRead(50).
    expect(res.inputTokens).toBe(110);
    expect(res.cachedInputTokens).toBe(50);
    expect(res.outputTokens).toBe(20);
    expect(res.stopReason).toBe('tool_use');
    // Telemetry: canonical id (not the eu profile) + the residency region tag.
    expect(res.modelId).toBe('claude-sonnet-4-6');
    expect(calls[0]?.modelId).toBe('claude-sonnet-4-6');
    expect(calls[0]?.region).toBe('eu-west-2');
    expect(calls[0]?.inputTokens).toBe(110);
    expect(calls[0]?.cachedInputTokens).toBe(50);
  });

  it('maps end_turn / max_tokens stop reasons and a no-tool text response', async () => {
    const { client } = fakeClient(
      converseOutput({
        output: { message: { role: 'assistant', content: [{ text: 'plain answer' }] } },
        stopReason: 'max_tokens',
      }),
    );
    const provider = new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: PROFILES,
      client,
    });
    const { ctx } = fakeCallContext();
    const res = await provider.complete({ system: 's', messages: [] }, ctx);
    expect(res.text).toBe('plain answer');
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe('max_tokens');
  });

  it('records a failed call (region + modelId) and rethrows a typed ProviderError', async () => {
    const client = {
      async send(): Promise<never> {
        throw Object.assign(new Error('ValidationException: bad'), {
          name: 'ValidationException',
          $metadata: { httpStatusCode: 400 },
        });
      },
    } as unknown as FakeClient;
    const provider = new BedrockLLMProvider({
      region: 'eu-west-2',
      defaultModel: 'claude-sonnet-4-6',
      modelProfiles: PROFILES,
      client,
    });
    const { ctx, calls } = fakeCallContext();
    await expect(provider.complete({ system: 's', messages: [] }, ctx)).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(calls[0]?.failed).toBe(true);
    expect(calls[0]?.region).toBe('eu-west-2');
  });
});

// --- Titan embeddings -------------------------------------------------------

function titanOutput(dim: number, tokens = 7): FakeOutput {
  const body = new TextEncoder().encode(
    JSON.stringify({ embedding: Array(dim).fill(0.01), inputTextTokenCount: tokens }),
  );
  return { $metadata: {}, contentType: 'application/json', body };
}

describe('BedrockTitanEmbeddingProvider', () => {
  it('embeds each text (1024-dim), sums tokens, and sends the Titan body shape', async () => {
    const { client, sent } = fakeClient(titanOutput(1024, 5));
    const provider = new BedrockTitanEmbeddingProvider({
      region: 'eu-west-2',
      modelId: 'amazon.titan-embed-text-v2:0',
      dimensions: 1024,
      client,
    });
    const { ctx, calls } = fakeCallContext();
    const res = await provider.embed({ texts: ['alpha', 'beta'], kind: 'document' }, ctx);

    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toHaveLength(1024);
    expect(res.inputTokens).toBe(10); // 5 per text × 2
    expect(res.modelId).toBe('amazon.titan-embed-text-v2:0');
    // One InvokeModel per text; body carries inputText + dimensions + normalize.
    expect(sent).toHaveLength(2);
    const body = JSON.parse(new TextDecoder().decode(sent[0]?.input.body as Uint8Array)) as {
      inputText: string;
      dimensions: number;
      normalize: boolean;
    };
    expect(body).toEqual({ inputText: 'alpha', dimensions: 1024, normalize: true });
    expect(calls[0]?.region).toBe('eu-west-2');
    expect(calls[0]?.purpose).toBe('embedding');
  });

  it('returns empty for an empty request without calling Bedrock', async () => {
    const { client, sent } = fakeClient(titanOutput(1024));
    const provider = new BedrockTitanEmbeddingProvider({
      region: 'eu-west-2',
      modelId: 'amazon.titan-embed-text-v2:0',
      dimensions: 1024,
      client,
    });
    const { ctx } = fakeCallContext();
    const res = await provider.embed({ texts: [], kind: 'document' }, ctx);
    expect(res.vectors).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('throws when the returned vector dimension does not match', async () => {
    const { client } = fakeClient(titanOutput(512));
    const provider = new BedrockTitanEmbeddingProvider({
      region: 'eu-west-2',
      modelId: 'amazon.titan-embed-text-v2:0',
      dimensions: 1024,
      client,
    });
    const { ctx } = fakeCallContext();
    await expect(provider.embed({ texts: ['x'], kind: 'document' }, ctx)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('provider factory — bedrock selection', () => {
  it('selects the Bedrock LLM provider (id, canonical sonnet default)', () => {
    const llm = loadLlmProvider({
      LLM_PROVIDER: 'bedrock',
      AWS_REGION: 'eu-west-2',
      BEDROCK_MODEL_SONNET: 'eu.sonnet.v1',
    });
    expect(llm.id).toBe('bedrock');
    expect(llm.defaultModel).toBe('claude-sonnet-4-6');
  });

  it('requires BEDROCK_MODEL_SONNET', () => {
    expect(() => loadLlmProvider({ LLM_PROVIDER: 'bedrock', AWS_REGION: 'eu-west-2' })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('selects the Bedrock Titan embedding provider at 1024 dim', () => {
    const embedding = loadEmbeddingProvider({
      EMBEDDING_PROVIDER: 'bedrock',
      AWS_REGION: 'eu-west-2',
    });
    expect(embedding.id).toBe('bedrock');
    expect(embedding.dimensions).toBe(1024);
    expect(embedding.modelId).toBe('amazon.titan-embed-text-v2:0');
  });
});

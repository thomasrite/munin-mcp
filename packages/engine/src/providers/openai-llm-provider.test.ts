// Unit tests for the OpenAI LLM provider — mock-level request/response mapping,
// no real key, no network. The injected `client` stands in for the OpenAI SDK.
//
// The CRITICAL coverage is the extraction path: the engine calls complete() with
// a forced `toolChoice: { type: 'tool', name }` and reads `LLMResponse.toolCalls`.
// We assert the engine's LLMTool → OpenAI function-tool mapping, the forced
// tool_choice mapping, and that the returned function call (arguments as a JSON
// STRING) parses back into the `{ id, name, input }` shape the Extractor expects.

import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { type NewLlmCall, asTenantId } from '../graph/types';
import { OpenAILLMProvider } from './openai-llm-provider';
import { AuthError, ProviderUnavailableError, RateLimitError } from './provider-errors';
import type { LLMRequest, ProviderCallContext } from './provider-types';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000a1');

function makeCtx(purpose: ProviderCallContext['purpose'] = 'extraction'): {
  ctx: ProviderCallContext;
  calls: NewLlmCall[];
} {
  const calls: NewLlmCall[] = [];
  const graphStore = {
    insertLlmCall: async (_w: unknown, params: NewLlmCall) => {
      calls.push(params);
    },
  } as unknown as GraphStoreWriter;
  return { ctx: { tenantId: TENANT, purpose, graphStore }, calls };
}

// A fake OpenAI client whose chat.completions.create returns a fixed body and
// records the params it was called with.
function fakeClient(body: unknown): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => body);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

// A minimal ChatCompletion-shaped response.
function completion(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string; type?: string }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
  model?: string;
}): unknown {
  return {
    model: opts.model ?? 'gpt-4.1-2025',
    choices: [
      {
        index: 0,
        finish_reason: opts.finishReason ?? (opts.toolCalls?.length ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: opts.content ?? null,
          ...(opts.toolCalls
            ? {
                tool_calls: opts.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: tc.type ?? 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        },
      },
    ],
    usage: opts.usage
      ? {
          prompt_tokens: opts.usage.prompt_tokens,
          completion_tokens: opts.usage.completion_tokens,
          total_tokens: opts.usage.prompt_tokens + opts.usage.completion_tokens,
          ...(opts.usage.cached_tokens !== undefined
            ? { prompt_tokens_details: { cached_tokens: opts.usage.cached_tokens } }
            : {}),
        }
      : undefined,
  };
}

const EXTRACT_TOOL = {
  name: 'extract_entities',
  description: 'Extract entities from the paragraph',
  inputSchema: {
    type: 'object',
    properties: { entities: { type: 'array' } },
    required: ['entities'],
  },
} as const;

describe('OpenAILLMProvider — construction', () => {
  it('rejects an empty api key and an empty default model', () => {
    expect(() => new OpenAILLMProvider({ apiKey: '', defaultModel: 'gpt-4.1' })).toThrow(
      /apiKey is required/,
    );
    expect(() => new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: '  ' })).toThrow(
      /defaultModel is required/,
    );
  });

  it('reports promptCaching capability (OpenAI auto-caches) and is symmetric', () => {
    const p = new OpenAILLMProvider({
      apiKey: 'sk-x',
      defaultModel: 'gpt-4.1',
      client: fakeClient({}).client,
    });
    expect(p.id).toBe('openai');
    expect(p.capabilities.promptCaching).toBe(true);
    expect(p.capabilities.asymmetricEmbeddings).toBe(false);
    expect(p.defaultModel).toBe('gpt-4.1');
  });
});

describe('OpenAILLMProvider — request mapping', () => {
  it('maps system → system message, threads turns, and uses the per-request model override', async () => {
    const { client, create } = fakeClient(
      completion({ content: 'hi', usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx('query');

    const req: LLMRequest = {
      model: 'gpt-4.1-mini',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 256,
      temperature: 0,
    };
    await p.complete(req, ctx);

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe('gpt-4.1-mini'); // request override beats default
    expect(params.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);
    expect(params.max_completion_tokens).toBe(256);
    expect(params.temperature).toBe(0);
    // temperature 0 must be SENT (it is meaningful, not falsy-omitted).
    expect('temperature' in params).toBe(true);
  });

  it('omits temperature when the request does not set it; defaults max tokens', async () => {
    const { client, create } = fakeClient(
      completion({ content: 'ok', usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx();

    await p.complete({ system: '', messages: [{ role: 'user', content: 'q' }] }, ctx);

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect('temperature' in params).toBe(false);
    expect(params.max_completion_tokens).toBe(4096);
    // empty system → no system message prepended
    expect(params.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('maps an LLMTool to an OpenAI function tool and a forced tool choice to a named function', async () => {
    const { client, create } = fakeClient(
      completion({
        toolCalls: [{ id: 'call_1', name: 'extract_entities', arguments: '{"entities":[]}' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx('extraction');

    await p.complete(
      {
        system: 'extract',
        messages: [{ role: 'user', content: 'para' }],
        tools: [EXTRACT_TOOL],
        toolChoice: { type: 'tool', name: 'extract_entities' },
        cacheableSystemPrefix: true,
      },
      ctx,
    );

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'extract_entities',
          description: 'Extract entities from the paragraph',
          parameters: EXTRACT_TOOL.inputSchema,
        },
      },
    ]);
    expect(params.tool_choice).toEqual({
      type: 'function',
      function: { name: 'extract_entities' },
    });
    // strict is deliberately not set (engine re-validates + repairs)
    const tool = (params.tools as Array<{ function: Record<string, unknown> }>)[0]!;
    expect('strict' in tool.function).toBe(false);
  });

  it("maps toolChoice 'any' → 'required', 'none' → 'none', 'auto' → 'auto'", async () => {
    const cases: Array<[LLMRequest['toolChoice'], unknown]> = [
      [{ type: 'any' }, 'required'],
      [{ type: 'none' }, 'none'],
      [{ type: 'auto' }, 'auto'],
    ];
    for (const [choice, expected] of cases) {
      const { client, create } = fakeClient(
        completion({ content: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      );
      const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
      const { ctx } = makeCtx();
      await p.complete(
        {
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          tools: [EXTRACT_TOOL],
          ...(choice ? { toolChoice: choice } : {}),
        },
        ctx,
      );
      const params = create.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.tool_choice).toEqual(expected);
    }
  });
});

describe('OpenAILLMProvider — response mapping (extraction tool_use path)', () => {
  it('parses a function tool call (JSON-string arguments) into { id, name, input }', async () => {
    const argsObj = { entities: [{ type: 'Person', properties: { fullName: 'Ada Vance' } }] };
    const { client } = fakeClient(
      completion({
        content: null,
        toolCalls: [
          { id: 'call_42', name: 'extract_entities', arguments: JSON.stringify(argsObj) },
        ],
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx('extraction');

    const res = await p.complete(
      {
        system: 'extract',
        messages: [{ role: 'user', content: 'para' }],
        tools: [EXTRACT_TOOL],
        toolChoice: { type: 'tool', name: 'extract_entities' },
      },
      ctx,
    );

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toEqual({
      id: 'call_42',
      name: 'extract_entities',
      input: argsObj, // arguments string parsed back to the object the Extractor reads
    });
    expect(res.text).toBe('');
    expect(res.stopReason).toBe('tool_use');
  });

  it('tolerates invalid-JSON arguments by yielding an empty input (Ajv/repair drives recovery)', async () => {
    const { client } = fakeClient(
      completion({
        toolCalls: [{ id: 'call_bad', name: 'extract_entities', arguments: '{not valid json' }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx('extraction');

    const res = await p.complete(
      {
        system: 's',
        messages: [{ role: 'user', content: 'p' }],
        tools: [EXTRACT_TOOL],
        toolChoice: { type: 'tool', name: 'extract_entities' },
      },
      ctx,
    );
    expect(res.toolCalls[0]!.input).toEqual({});
  });

  it('ignores non-function (custom) tool calls — we only define function tools', async () => {
    const { client } = fakeClient({
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'custom', custom: { name: 'x', input: 'y' } },
              {
                id: 'c2',
                type: 'function',
                function: { name: 'extract_entities', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx('extraction');

    const res = await p.complete(
      { system: 's', messages: [{ role: 'user', content: 'p' }], tools: [EXTRACT_TOOL] },
      ctx,
    );
    expect(res.toolCalls).toEqual([{ id: 'c2', name: 'extract_entities', input: {} }]);
  });

  it('splits cached tokens out of prompt_tokens and records telemetry honestly', async () => {
    const { client } = fakeClient(
      completion({
        content: 'answer',
        usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 800 },
      }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx, calls } = makeCtx('query');

    const res = await p.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, ctx);

    // prompt_tokens INCLUDES cached; billed non-cached input = 1000 - 800 = 200.
    expect(res.inputTokens).toBe(200);
    expect(res.cachedInputTokens).toBe(800);
    expect(res.outputTokens).toBe(50);
    expect(res.modelId).toBe('gpt-4.1-2025');
    expect(res.stopReason).toBe('end_turn');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.region).toBe('openai-api-us');
    expect(calls[0]!.purpose).toBe('query');
    expect(calls[0]!.inputTokens).toBe(200);
    expect(calls[0]!.cachedInputTokens).toBe(800);
    expect(calls[0]!.outputTokens).toBe(50);
  });

  it('maps finish_reason length → max_tokens', async () => {
    const { client } = fakeClient(
      completion({
        content: 'truncated',
        finishReason: 'length',
        usage: { prompt_tokens: 5, completion_tokens: 4096 },
      }),
    );
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx } = makeCtx();
    const res = await p.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, ctx);
    expect(res.stopReason).toBe('max_tokens');
  });
});

describe('OpenAILLMProvider — error mapping + failed-call telemetry', () => {
  async function expectMapped(status: number, matcher: (e: unknown) => boolean): Promise<void> {
    const err = new OpenAI.APIError(
      status,
      { error: { message: `boom ${status}` } },
      undefined,
      new Headers(),
    );
    const create = vi.fn(async () => {
      throw err;
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const p = new OpenAILLMProvider({ apiKey: 'sk-x', defaultModel: 'gpt-4.1', client });
    const { ctx, calls } = makeCtx('extraction');
    await expect(
      p.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, ctx),
    ).rejects.toSatisfy(matcher);
    // A failed call still records one telemetry row marked failed.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.failed).toBe(true);
    expect(calls[0]!.region).toBe('openai-api-us');
  }

  it('maps 401 → AuthError', () => expectMapped(401, (e) => e instanceof AuthError));
  it('maps 429 → RateLimitError', () => expectMapped(429, (e) => e instanceof RateLimitError));
  it('maps 500 → ProviderUnavailableError', () =>
    expectMapped(500, (e) => e instanceof ProviderUnavailableError));
});

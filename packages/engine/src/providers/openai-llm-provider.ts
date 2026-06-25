// OpenAI LLM provider. Talks to the OpenAI Chat Completions API directly.
//
// This is a DEV / BYO-key alternative to AnthropicLLMProvider against the same
// `LLMProvider` interface — it exists so the multi-model extraction bake-off can
// score OpenAI models on the SAME pipeline as the Anthropic and local legs. It is
// a US-hosted endpoint, so the provider factory REFUSES it under MUNIN_LOCAL_MODE
// and under MUNIN_REQUIRE_UK_RESIDENCY (same posture as `anthropic`). No engine
// code imports this class directly; it is constructed only by `provider-factory.ts`.
//
// CRITICAL — the extraction path is tool_use ONLY. The engine's extractor,
// query, and generation paths all call `complete()` with a forced
// `toolChoice: { type: 'tool', name }` and parse `LLMResponse.toolCalls`. This
// provider maps the engine's `LLMTool` definitions to OpenAI function tools and
// the forced tool choice to OpenAI's named `tool_choice`, then parses the
// returned function call back into the EXACT shape the Extractor expects (the
// same shape AnthropicLLMProvider returns: `{ id, name, input }` with `input`
// the parsed JSON arguments).
//
// The `openai` SDK import lives ONLY in this file and openai-embedding-provider.ts.

import OpenAI from 'openai';

import { asActorId } from '../graph/types';
import {
  AuthError,
  ContextLengthError,
  ProviderConfigurationError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitError,
} from './provider-errors';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';

const PROVIDER_ID = 'openai';
// The OpenAI public API is US-hosted. Recorded honestly in `llm_calls.region`
// so cost telemetry reflects where the call landed (distinct from the
// embedding provider's 'openai-api-us' rows by purpose + actor).
const REGION = 'openai-api-us';
// Distinct actor from the embedding provider ('provider:openai') so LLM calls
// and embedding calls are separable in the audit/cost trail.
const ACTOR = asActorId('provider:openai-llm');

export interface OpenAILLMProviderConfig {
  readonly apiKey: string;
  readonly defaultModel: string;
  // Optional injected client for tests (mock-level request/response mapping).
  readonly client?: OpenAI;
}

export class OpenAILLMProvider implements LLMProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    // OpenAI prompt caching is AUTOMATIC (no opt-in) for prompts above its
    // minimum prefix size — it surfaces as usage.prompt_tokens_details.
    // cached_tokens, which we report. So `cacheableSystemPrefix` is honoured
    // as a transparent no-op rather than an explicit cache_control marker.
    promptCaching: true,
    asymmetricEmbeddings: false,
    // Conservative floor across current chat models (gpt-4.1 family is far
    // higher). A capability hint, not an enforced bound.
    maxInputTokens: 128_000,
    maxBatchSize: 1,
  };
  readonly defaultModel: string;

  private readonly client: OpenAI;

  constructor(config: OpenAILLMProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'apiKey is required');
    }
    if (!config.defaultModel.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'defaultModel is required');
    }
    this.defaultModel = config.defaultModel;
    this.client = config.client ?? new OpenAI({ apiKey: config.apiKey });
  }

  async complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel;
    const startedAt = Date.now();
    try {
      // Messages: the engine's `system` becomes a leading system message; the
      // turn messages follow unchanged. (OpenAI prompt caching keys on the
      // identical leading prefix, so a stable system+tools prefix caches
      // transparently — no marker to set.)
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      // Tools array → OpenAI function tools. The inputSchema is a JSON Schema
      // object; OpenAI takes it verbatim as `function.parameters`. `strict` is
      // deliberately LEFT UNSET (default false): the engine's schemas may use
      // JSON-Schema features OpenAI strict mode rejects, and the extractor
      // already re-validates every tool call with Ajv + one repair retry, so
      // strict adherence here would only narrow model compatibility.
      let toolsParam: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined;
      if (request.tools && request.tools.length > 0) {
        toolsParam = request.tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
          },
        }));
      }

      // Tool choice: mirror the engine's four-way LLMToolChoice onto OpenAI's
      // shape. 'tool' (the forced choice the extractor/query/generation paths
      // use) → a named function choice; 'any' → 'required'; 'none'/'auto' as-is.
      let toolChoiceParam: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined;
      if (request.toolChoice) {
        if (request.toolChoice.type === 'tool' && request.toolChoice.name) {
          toolChoiceParam = { type: 'function', function: { name: request.toolChoice.name } };
        } else if (request.toolChoice.type === 'any') {
          toolChoiceParam = 'required';
        } else if (request.toolChoice.type === 'none') {
          toolChoiceParam = 'none';
        } else {
          toolChoiceParam = 'auto';
        }
      }

      const response = await this.client.chat.completions.create({
        model,
        messages,
        // max_completion_tokens is the current param (max_tokens is deprecated
        // and rejected by newer models); both are accepted by the chat models.
        max_completion_tokens: request.maxOutputTokens ?? 4096,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(toolsParam !== undefined ? { tools: toolsParam } : {}),
        ...(toolChoiceParam !== undefined ? { tool_choice: toolChoiceParam } : {}),
      });

      const choice = response.choices[0];
      const message = choice?.message;

      // Text content (may be null/absent when the model only called a tool).
      const text = message?.content ?? '';

      // tool_use blocks → the same `{ id, name, input }` shape the Anthropic
      // provider returns. OpenAI returns function arguments as a JSON STRING;
      // we parse it. A model may emit invalid JSON — parse defensively to {}
      // so the extractor's Ajv re-validation drives the repair retry rather
      // than throwing here (mirrors the Ollama provider's tolerance). Custom
      // (non-function) tool calls are filtered out — we only define functions.
      const toolCalls: LLMToolCall[] = (message?.tool_calls ?? [])
        .filter(
          (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
            tc.type === 'function',
        )
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: safeParseObject(tc.function.arguments),
        }));

      // Usage. OpenAI's prompt_tokens INCLUDES cached tokens; our schema splits
      // billed non-cached input from cheap cache reads, so subtract.
      const usage = response.usage;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const inputTokens = Math.max(0, promptTokens - cachedInputTokens);
      const outputTokens = usage?.completion_tokens ?? 0;

      await ctx.graphStore.insertLlmCall(
        { tenantId: ctx.tenantId, actor: ACTOR },
        {
          purpose: ctx.purpose,
          modelId: model,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          latencyMs: Date.now() - startedAt,
          region: REGION,
          ...(ctx.extractorVersionId !== undefined
            ? { extractorVersionId: ctx.extractorVersionId }
            : {}),
          ...(ctx.documentId !== undefined ? { documentId: ctx.documentId } : {}),
        },
      );

      return {
        text,
        toolCalls,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        modelId: response.model || model,
        stopReason: mapFinishReason(choice?.finish_reason),
      };
    } catch (err) {
      // Best-effort record of the failed call; swallow telemetry failures so the
      // original error surfaces unmasked.
      await ctx.graphStore
        .insertLlmCall(
          { tenantId: ctx.tenantId, actor: ACTOR },
          {
            purpose: ctx.purpose,
            modelId: model,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - startedAt,
            region: REGION,
            failed: true,
            ...(ctx.extractorVersionId !== undefined
              ? { extractorVersionId: ctx.extractorVersionId }
              : {}),
            ...(ctx.documentId !== undefined ? { documentId: ctx.documentId } : {}),
          },
        )
        .catch(() => {});
      throw mapOpenAIError(err);
    }
  }
}

function safeParseObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapFinishReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] | undefined,
): LLMResponse['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'other';
  }
}

function mapOpenAIError(err: unknown): Error {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) return new AuthError(PROVIDER_ID, err);
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers);
      return new RateLimitError(PROVIDER_ID, retryAfter, err);
    }
    if (
      status === 400 &&
      /maximum context|context length|too long|too many tokens/i.test(err.message)
    ) {
      return new ContextLengthError(PROVIDER_ID, 0, 0, err);
    }
    if (status >= 500) return new ProviderUnavailableError(PROVIDER_ID, err);
    return new ProviderError(PROVIDER_ID, err.message, err);
  }
  if (err instanceof Error) return new ProviderError(PROVIDER_ID, err.message, err);
  return new ProviderError(PROVIDER_ID, 'unknown error', err);
}

function parseRetryAfter(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const raw = (headers as Record<string, string | undefined>)['retry-after'];
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

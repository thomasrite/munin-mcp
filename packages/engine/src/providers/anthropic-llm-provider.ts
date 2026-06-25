// Anthropic LLM provider. Talks to the public Anthropic API directly.
//
// Production (Phase 5) replaces this with `BedrockLLMProvider` against the
// same `LLMProvider` interface. No engine code imports this class directly;
// it is constructed only by `provider-factory.ts`.

import Anthropic from '@anthropic-ai/sdk';

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
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';

const PROVIDER_ID = 'anthropic';

// Anthropic's minimum cacheable prefix size for current Claude models.
// Below this, the cache_control marker is ignored — we log and proceed.
const MIN_CACHEABLE_TOKENS = 1024;

// The Anthropic public API is single-region (US). Recorded honestly in
// `llm_calls.region` so cost telemetry reflects where the call landed.
// Phase 5 Bedrock provider writes `eu-west-2`.
const REGION = 'anthropic-api-us';

const ACTOR = asActorId('provider:anthropic');

export interface AnthropicLLMProviderConfig {
  readonly apiKey: string;
  readonly defaultModel: string;
  // Optional injected client for tests.
  readonly client?: Anthropic;
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    promptCaching: true,
    asymmetricEmbeddings: false,
    maxInputTokens: 200_000,
    maxBatchSize: 1,
  };
  readonly defaultModel: string;

  private readonly client: Anthropic;

  constructor(config: AnthropicLLMProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'apiKey is required');
    }
    if (!config.defaultModel.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'defaultModel is required');
    }
    this.defaultModel = config.defaultModel;
    this.client = config.client ?? new Anthropic({ apiKey: config.apiKey });
  }

  async complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel;
    const startedAt = Date.now();
    try {
      // cache_control shape (SDK 0.97 types include this natively):
      //   { type: 'ephemeral' }              — 5-minute TTL (default)
      //   { type: 'ephemeral', ttl: '1h' }   — extended 1-hour TTL
      // The tier is selected by request.cacheTier; ephemeral when omitted.
      const cacheTier = request.cacheTier ?? 'ephemeral';
      const cacheControlBlock: Anthropic.CacheControlEphemeral =
        cacheTier === 'extended' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

      const systemParam: string | Anthropic.TextBlockParam[] = request.cacheableSystemPrefix
        ? [{ type: 'text', text: request.system, cache_control: cacheControlBlock }]
        : request.system;

      // Tools array. Mark the LAST tool with cache_control when caching is
      // requested so the (tools) prefix is a cache boundary; system is
      // separately cached above. With both layers Anthropic can serve a
      // partial cache hit when one changes but not the other.
      let toolsParam: Anthropic.Tool[] | undefined;
      if (request.tools && request.tools.length > 0) {
        const tools = request.tools;
        toolsParam = tools.map((t, i) => {
          const last = i === tools.length - 1;
          const def: Anthropic.Tool = {
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          };
          if (last && request.cacheableSystemPrefix) {
            def.cache_control = cacheControlBlock;
          }
          return def;
        });
      }

      let toolChoiceParam: Anthropic.ToolChoice | undefined;
      if (request.toolChoice) {
        if (request.toolChoice.type === 'tool' && request.toolChoice.name) {
          toolChoiceParam = { type: 'tool', name: request.toolChoice.name };
        } else if (request.toolChoice.type === 'any') {
          toolChoiceParam = { type: 'any' };
        } else if (request.toolChoice.type === 'none') {
          toolChoiceParam = { type: 'none' };
        } else {
          toolChoiceParam = { type: 'auto' };
        }
      }

      const response = await this.client.messages.create({
        model,
        system: systemParam,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: request.maxOutputTokens ?? 4096,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(toolsParam !== undefined ? { tools: toolsParam } : {}),
        ...(toolChoiceParam !== undefined ? { tool_choice: toolChoiceParam } : {}),
      });

      // Walk all content blocks. Text blocks get concatenated into `text`;
      // tool_use blocks become structured `toolCalls`. Claude may emit a
      // brief text block before a tool call ("I'll extract the entities now")
      // — we preserve that text for debugging but don't act on it.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        }));

      // SDK 0.97 includes cache_creation/read fields natively (nullable).
      const usage = response.usage;
      // Anthropic semantics:
      //   input_tokens             = regular input (excludes cache reads)
      //   cache_creation_input_tokens = tokens written to cache this call
      //   cache_read_input_tokens     = tokens served from cache this call
      // Our schema columns:
      //   input_tokens         = non-cached input billed at base price or higher
      //   cached_input_tokens  = free cache reads
      // We sum (input + creation) into our inputTokens because both are
      // billed-this-call; cache_read is the free portion.
      const inputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
      const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
      const outputTokens = usage.output_tokens;

      // If the caller asked for caching but neither a creation nor a read
      // happened, the system prompt was likely below the minimum cacheable
      // size for this model. Warn so this doesn't go unnoticed during
      // development.
      if (
        request.cacheableSystemPrefix &&
        cachedInputTokens === 0 &&
        (usage.cache_creation_input_tokens ?? 0) === 0
      ) {
        console.warn(
          `[${PROVIDER_ID}] cacheableSystemPrefix requested but no cache creation or read occurred; system prompt may be below the ${MIN_CACHEABLE_TOKENS}-token minimum for model ${model}`,
        );
      }

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
        modelId: model,
        stopReason: mapStopReason(response.stop_reason),
      };
    } catch (err) {
      // Best-effort record of failed call. Swallow telemetry failures so the
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
      throw mapAnthropicError(err);
    }
  }
}

function mapStopReason(s: Anthropic.Message['stop_reason']): LLMResponse['stopReason'] {
  switch (s) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    default:
      return 'other';
  }
}

function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) return new AuthError(PROVIDER_ID, err);
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers);
      return new RateLimitError(PROVIDER_ID, retryAfter, err);
    }
    if (status === 400 && /maximum context|context length|too long/i.test(err.message)) {
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

// Bedrock LLM provider — Claude on AWS Bedrock, region eu-west-2 (London).
//
// The production residency implementation behind the same `LLMProvider`
// interface as `AnthropicLLMProvider`. PARITY ONLY: it maps our canonical
// LLMRequest to the Bedrock Converse API and back — no prompt or retrieval
// logic lives here. No engine code imports `@aws-sdk/*` outside this file and
// `bedrock-titan-embedding-provider.ts`; the architecture-reviewer enforces it.
//
// Auth: a Bedrock API key (bearer token) read from `AWS_BEARER_TOKEN_BEDROCK` —
// recent @aws-sdk/client-bedrock-runtime versions pick it up automatically, so
// we construct the client with only a region and never hard-require static IAM
// keys. If the bearer token is unset, the SDK falls back to the default AWS
// credential chain.
//
// Model ids: callers pass our canonical ids ('claude-sonnet-4-6', …); we map
// the family to the eu inference-profile id supplied in env. Telemetry records
// the CANONICAL id (so `pricing.ts` / cache-report keep working) and tags
// region 'eu-west-2'; the profile id is only the wire model.

import { Agent } from 'node:https';

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolChoice,
} from '@aws-sdk/client-bedrock-runtime';

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
import { DEFAULT_RESILIENCE, type ResilienceOptions, invokeWithResilience } from './resilience';

const PROVIDER_ID = 'bedrock';

// London region. Recorded in `llm_calls.region` so the residency story is
// evidenced per call (the Anthropic dev provider writes 'anthropic-api-us').
const REGION_TAG = 'eu-west-2';

const ACTOR = asActorId('provider:bedrock');

// Below this the Bedrock cachePoint is a no-op (same ~1024-token floor as the
// Anthropic cache). We log and proceed.
const MIN_CACHEABLE_TOKENS = 1024;

// Reuse TCP connections across calls instead of a fresh socket per request (less
// ephemeral-port churn over a long run, lower latency).
const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 32 });

// Our canonical model ids → the eu inference-profile id for each Claude family.
// Profile ids are env-supplied (BEDROCK_MODEL_*), so they stay configurable and
// no vertical/account specifics are baked in here.
export interface BedrockModelProfiles {
  readonly opus?: string;
  readonly sonnet?: string;
  readonly haiku?: string;
}

export interface BedrockLLMProviderConfig {
  readonly region: string;
  readonly modelProfiles: BedrockModelProfiles;
  // Canonical default model. Sonnet — Opus is not enabled on this account; the
  // Opus mapping is kept for when access is granted later.
  readonly defaultModel: string;
  // Optional injected client for tests (a fake with a compatible `send`).
  readonly client?: BedrockRuntimeClient;
  // Per-call timeout + retry policy (defaults: 60s, 4 attempts). Injected by tests.
  readonly resilience?: Partial<Omit<ResilienceOptions, 'providerId'>>;
}

export class BedrockLLMProvider implements LLMProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    promptCaching: true,
    asymmetricEmbeddings: false,
    maxInputTokens: 200_000,
    maxBatchSize: 1,
  };
  readonly defaultModel: string;

  private readonly client: BedrockRuntimeClient;
  private readonly profiles: BedrockModelProfiles;
  private readonly resilience: ResilienceOptions;

  constructor(config: BedrockLLMProviderConfig) {
    if (!config.region.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'region is required');
    }
    if (!config.defaultModel.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'defaultModel is required');
    }
    this.defaultModel = config.defaultModel;
    this.profiles = config.modelProfiles;
    this.resilience = {
      providerId: PROVIDER_ID,
      timeoutMs: config.resilience?.timeoutMs ?? DEFAULT_RESILIENCE.timeoutMs,
      maxAttempts: config.resilience?.maxAttempts ?? DEFAULT_RESILIENCE.maxAttempts,
      baseDelayMs: config.resilience?.baseDelayMs ?? DEFAULT_RESILIENCE.baseDelayMs,
      ...(config.resilience?.sleep ? { sleep: config.resilience.sleep } : {}),
      ...(config.resilience?.random ? { random: config.resilience.random } : {}),
    };
    // No credentials passed — the SDK reads AWS_BEARER_TOKEN_BEDROCK if present,
    // else the default credential chain. Explicit socket + connection timeouts
    // abort a stalled call; maxAttempts: 1 leaves retry to the resilience wrapper.
    this.client =
      config.client ??
      new BedrockRuntimeClient({
        region: config.region,
        maxAttempts: 1,
        requestHandler: {
          requestTimeout: this.resilience.timeoutMs,
          connectionTimeout: 10_000,
          httpsAgent: keepAliveAgent,
        },
      });
  }

  // Map a canonical model id (or a profile id) to the eu inference-profile id by
  // Claude family. Throws if that family's profile is not configured.
  private resolveProfile(model: string): string {
    const m = model.toLowerCase();
    const family: keyof BedrockModelProfiles = m.includes('opus')
      ? 'opus'
      : m.includes('haiku')
        ? 'haiku'
        : 'sonnet';
    const profile = this.profiles[family];
    if (!profile || !profile.trim()) {
      throw new ProviderConfigurationError(
        PROVIDER_ID,
        `no Bedrock inference-profile id configured for the '${family}' family (set BEDROCK_MODEL_${family.toUpperCase()})`,
      );
    }
    return profile;
  }

  async complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    // Canonical id — recorded in telemetry + returned. The wire model is the
    // resolved profile id.
    const model = request.model ?? this.defaultModel;
    const profileId = this.resolveProfile(model);
    const startedAt = Date.now();

    try {
      // Prompt-cache parity: a cachePoint AFTER the system content and AFTER the
      // tools array marks the same static prefix the Anthropic provider caches.
      // Bedrock's cachePoint is single-tier ('default', ~5-min); cacheTier is
      // accepted for interface parity but Bedrock exposes no per-point TTL knob.
      const cacheable = request.cacheableSystemPrefix === true;

      const system: SystemContentBlock[] = [{ text: request.system }];
      if (cacheable) system.push({ cachePoint: { type: 'default' } });

      const messages: Message[] = request.messages.map((mm) => ({
        role: mm.role,
        content: [{ text: mm.content }],
      }));

      let toolConfig: ConverseCommandInput['toolConfig'];
      if (request.tools && request.tools.length > 0 && request.toolChoice?.type !== 'none') {
        // The SDK types toolSpec.inputSchema.json as a recursive DocumentType;
        // our inputSchema is a plain JSON-Schema object. The cast bridges that
        // variance — the shape is exactly what Bedrock expects at runtime.
        const tools = request.tools.map(
          (t) =>
            ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: { json: t.inputSchema as Record<string, unknown> },
              },
            }) as Tool,
        );
        // cachePoint after the tools array (the second cache boundary).
        const toolList: Tool[] = cacheable
          ? [...tools, { cachePoint: { type: 'default' } }]
          : tools;
        const toolChoice = mapToolChoice(request.toolChoice);
        toolConfig = { tools: toolList, ...(toolChoice ? { toolChoice } : {}) };
      }

      const command = new ConverseCommand({
        modelId: profileId,
        system,
        messages,
        ...(toolConfig ? { toolConfig } : {}),
        inferenceConfig: {
          maxTokens: request.maxOutputTokens ?? 4096,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
      });

      const response: ConverseCommandOutput = await invokeWithResilience(
        ({ abortSignal }) => this.client.send(command, { abortSignal }),
        this.resilience,
      );

      // Walk content blocks: text blocks concatenate into `text`; toolUse blocks
      // become structured `toolCalls` (the exclusive-union members expose only
      // their own key, so a plain map/filter is enough).
      const blocks = response.output?.message?.content ?? [];
      const text = blocks.map((b) => b.text ?? '').join('');
      const toolCalls = blocks
        .map((b) => b.toolUse)
        .filter((tu): tu is NonNullable<typeof tu> => tu !== undefined)
        .map((tu) => ({
          id: tu.toolUseId ?? '',
          name: tu.name ?? '',
          input: (tu.input ?? {}) as Record<string, unknown>,
        }));

      // Bedrock usage: inputTokens excludes cache reads; cacheWrite is creation,
      // cacheRead is the free portion. Mirror the Anthropic provider: bill
      // (input + creation) as inputTokens; cacheRead is cachedInputTokens.
      const usage = response.usage;
      const cacheWrite = usage?.cacheWriteInputTokens ?? 0;
      const cachedInputTokens = usage?.cacheReadInputTokens ?? 0;
      const inputTokens = (usage?.inputTokens ?? 0) + cacheWrite;
      const outputTokens = usage?.outputTokens ?? 0;

      if (cacheable && cachedInputTokens === 0 && cacheWrite === 0) {
        console.warn(
          `[${PROVIDER_ID}] cacheableSystemPrefix requested but no cachePoint creation or read occurred; prefix may be below the ${MIN_CACHEABLE_TOKENS}-token minimum for model ${profileId}`,
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
          region: REGION_TAG,
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
        stopReason: mapStopReason(response.stopReason),
      };
    } catch (err) {
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
            region: REGION_TAG,
            failed: true,
            ...(ctx.extractorVersionId !== undefined
              ? { extractorVersionId: ctx.extractorVersionId }
              : {}),
            ...(ctx.documentId !== undefined ? { documentId: ctx.documentId } : {}),
          },
        )
        .catch(() => {});
      throw mapBedrockError(err);
    }
  }
}

// `ConverseCommandInput` is imported as a type only where needed; alias for the
// toolConfig shape so the local binding above stays typed without widening.
type ConverseCommandInput = ConstructorParameters<typeof ConverseCommand>[0];

function mapToolChoice(choice: LLMRequest['toolChoice']): ToolChoice | undefined {
  if (!choice) return undefined;
  if (choice.type === 'tool' && choice.name) return { tool: { name: choice.name } };
  if (choice.type === 'any') return { any: {} };
  if (choice.type === 'auto') return { auto: {} };
  // 'none' is handled by the caller (toolConfig is omitted); nothing to choose.
  return undefined;
}

function mapStopReason(s: ConverseCommandOutput['stopReason']): LLMResponse['stopReason'] {
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

interface BedrockErrorLike {
  readonly name?: string;
  readonly message?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function mapBedrockError(err: unknown): Error {
  // Already-typed provider errors (e.g. ProviderTimeoutError from the resilience
  // wrapper) pass through unchanged.
  if (err instanceof ProviderError) return err;
  const e = (err ?? {}) as BedrockErrorLike;
  const name = e.name ?? '';
  const status = e.$metadata?.httpStatusCode ?? 0;
  const message = e.message ?? 'unknown error';

  if (
    status === 401 ||
    status === 403 ||
    /AccessDenied|UnrecognizedClient|Unauthorized|Forbidden|ExpiredToken/i.test(name)
  ) {
    return new AuthError(PROVIDER_ID, err);
  }
  if (status === 429 || /Throttl|TooManyRequests|ServiceQuota/i.test(name)) {
    return new RateLimitError(PROVIDER_ID, undefined, err);
  }
  if (/Validation/i.test(name) && /context|too long|maximum|token/i.test(message)) {
    return new ContextLengthError(PROVIDER_ID, 0, 0, err);
  }
  if (
    status >= 500 ||
    /ServiceUnavailable|InternalServer|ModelTimeout|Timeout|ModelNotReady/i.test(name)
  ) {
    return new ProviderUnavailableError(PROVIDER_ID, err);
  }
  if (err instanceof Error) return new ProviderError(PROVIDER_ID, err.message, err);
  return new ProviderError(PROVIDER_ID, message, err);
}

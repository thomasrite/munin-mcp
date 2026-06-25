// Bedrock Titan embedding provider — amazon.titan-embed-text-v2:0 at 1024 dim,
// region eu-west-2 (London).
//
// The production residency implementation behind the same `EmbeddingProvider`
// interface as `OpenAIEmbeddingProvider`. PARITY ONLY. The AWS SDK import is
// confined to this file + `bedrock-llm-provider.ts`. Auth is the Bedrock bearer
// token (AWS_BEARER_TOKEN_BEDROCK) the SDK reads automatically, else the default
// credential chain — the same one token covers Titan and Claude.
//
// Titan v2 embeds ONE inputText per InvokeModel call (no batch endpoint), so a
// multi-text request loops; the dimensions param truncates to 1024 to match the
// engine's vector(1024) column.

import { Agent } from 'node:https';

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
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
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';
import {
  DEFAULT_RESILIENCE,
  type ResilienceOptions,
  invokeWithResilience,
  mapWithConcurrency,
} from './resilience';

const PROVIDER_ID = 'bedrock';
const REGION_TAG = 'eu-west-2';
const ACTOR = asActorId('provider:bedrock');

// REUSE TCP connections across the thousands of calls a bulk ingest makes, instead
// of opening a fresh socket per request — far less ephemeral-port churn (a 10k-doc
// run otherwise exhausts local addresses → EADDRNOTAVAIL) and lower latency.
const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 64 });

// Titan Text Embeddings v2 input ceiling (~8192 tokens). Rough char proxy used
// for a cheap pre-flight (no client-side tokenizer), mirroring the OpenAI provider.
const MAX_INPUT_TOKENS = 8192;

interface TitanEmbedResponse {
  readonly embedding: number[];
  readonly inputTextTokenCount: number;
}

export interface BedrockTitanEmbeddingProviderConfig {
  readonly region: string;
  readonly modelId: string; // 'amazon.titan-embed-text-v2:0'
  readonly dimensions: number; // 1024 (must match schema EMBEDDING_DIMENSIONS)
  readonly client?: BedrockRuntimeClient; // injected for tests
  // Per-call timeout + retry policy (defaults: 60s, 4 attempts). Injected by tests.
  readonly resilience?: Partial<Omit<ResilienceOptions, 'providerId'>>;
  // Titan embeds one text per call; this many run concurrently within one embed()
  // call so a multi-paragraph batch is fast (default 8).
  readonly concurrency?: number;
}

export class BedrockTitanEmbeddingProvider implements EmbeddingProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: MAX_INPUT_TOKENS,
    maxBatchSize: 1,
  };
  readonly dimensions: number;
  readonly modelId: string;

  private readonly client: BedrockRuntimeClient;
  private readonly resilience: ResilienceOptions;
  private readonly concurrency: number;

  constructor(config: BedrockTitanEmbeddingProviderConfig) {
    if (!config.region.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'region is required');
    }
    if (!config.modelId.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'modelId is required');
    }
    if (config.dimensions <= 0) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'dimensions must be > 0');
    }
    this.modelId = config.modelId;
    this.dimensions = config.dimensions;
    this.resilience = {
      providerId: PROVIDER_ID,
      timeoutMs: config.resilience?.timeoutMs ?? DEFAULT_RESILIENCE.timeoutMs,
      maxAttempts: config.resilience?.maxAttempts ?? DEFAULT_RESILIENCE.maxAttempts,
      baseDelayMs: config.resilience?.baseDelayMs ?? DEFAULT_RESILIENCE.baseDelayMs,
      ...(config.resilience?.sleep ? { sleep: config.resilience.sleep } : {}),
      ...(config.resilience?.random ? { random: config.resilience.random } : {}),
    };
    this.concurrency = config.concurrency ?? 8;
    // SDK-level socket safety: an explicit request (socket-inactivity) + connection
    // timeout aborts a stalled socket; maxAttempts: 1 leaves retry to the resilience
    // wrapper (one clear policy, no double-retry). Confined to this provider file.
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

  async embed(request: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse> {
    if (request.texts.length === 0) {
      return { vectors: [], inputTokens: 0, modelId: this.modelId };
    }

    for (const text of request.texts) {
      const approxTokens = Math.ceil(text.length / 3.5);
      if (approxTokens > MAX_INPUT_TOKENS) {
        throw new ContextLengthError(PROVIDER_ID, approxTokens, MAX_INPUT_TOKENS);
      }
    }

    const startedAt = Date.now();
    const vectors: number[][] = [];
    let totalInputTokens = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    try {
      // Titan embeds one inputText per call. Run up to `concurrency` calls in
      // flight (order preserved) and wrap EACH call in the resilience policy
      // (per-attempt timeout + bounded retry) so one stalled or transiently-failing
      // call can never hang the batch. `normalize: true` keeps the vectors
      // unit-length for cosine distance (the engine's HNSW metric).
      const perText = await mapWithConcurrency(request.texts, this.concurrency, async (text) => {
        const command = new InvokeModelCommand({
          modelId: this.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: encoder.encode(
            JSON.stringify({ inputText: text, dimensions: this.dimensions, normalize: true }),
          ),
        });
        const response: InvokeModelCommandOutput = await invokeWithResilience(
          ({ abortSignal }) => this.client.send(command, { abortSignal }),
          this.resilience,
        );
        const parsed = JSON.parse(decoder.decode(response.body)) as TitanEmbedResponse;
        if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== this.dimensions) {
          throw new ProviderError(
            PROVIDER_ID,
            `vector dimension mismatch — expected ${this.dimensions}, got ${parsed.embedding?.length}`,
          );
        }
        return { vector: parsed.embedding, tokens: parsed.inputTextTokenCount ?? 0 };
      });
      for (const r of perText) {
        vectors.push(r.vector);
        totalInputTokens += r.tokens;
      }

      await ctx.graphStore.insertLlmCall(
        { tenantId: ctx.tenantId, actor: ACTOR },
        {
          purpose: 'embedding',
          modelId: this.modelId,
          inputTokens: totalInputTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedAt,
          region: REGION_TAG,
          ...(ctx.extractorVersionId !== undefined
            ? { extractorVersionId: ctx.extractorVersionId }
            : {}),
          metadata: { vectorCount: vectors.length, batchCount: request.texts.length },
        },
      );

      return { vectors, inputTokens: totalInputTokens, modelId: this.modelId };
    } catch (err) {
      await ctx.graphStore
        .insertLlmCall(
          { tenantId: ctx.tenantId, actor: ACTOR },
          {
            purpose: 'embedding',
            modelId: this.modelId,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - startedAt,
            region: REGION_TAG,
            failed: true,
            ...(ctx.extractorVersionId !== undefined
              ? { extractorVersionId: ctx.extractorVersionId }
              : {}),
          },
        )
        .catch(() => {});
      throw mapBedrockError(err);
    }
  }
}

interface BedrockErrorLike {
  readonly name?: string;
  readonly message?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function mapBedrockError(err: unknown): Error {
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
    return new ContextLengthError(PROVIDER_ID, 0, MAX_INPUT_TOKENS, err);
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

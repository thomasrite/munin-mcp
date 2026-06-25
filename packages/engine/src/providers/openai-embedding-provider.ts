// OpenAI embedding provider — text-embedding-3-small at 1024 dim (MRL-truncated).
//
// Production (Phase 5) replaces this with `BedrockTitanEmbeddingProvider`
// against the same `EmbeddingProvider` interface.

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
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';

const PROVIDER_ID = 'openai';
const REGION = 'openai-api-us';
const ACTOR = asActorId('provider:openai');

// Batch ceiling we send to OpenAI per call. The API supports up to 2048
// inputs and ~300k tokens — we stay well below so a single oversize text
// doesn't fail an otherwise valid batch.
const BATCH_LIMIT = 200;

// Per-input token ceiling for text-embedding-3-* (8191).
const MAX_INPUT_TOKENS = 8191;

export interface OpenAIEmbeddingProviderConfig {
  readonly apiKey: string;
  readonly modelId: string; // 'text-embedding-3-small'
  readonly dimensions: number; // 1024 (must match schema EMBEDDING_DIMENSIONS)
  readonly client?: OpenAI; // injected for tests
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: MAX_INPUT_TOKENS,
    maxBatchSize: BATCH_LIMIT,
  };
  readonly dimensions: number;
  readonly modelId: string;

  private readonly client: OpenAI;
  private warnedAboutAsymmetric = false;

  constructor(config: OpenAIEmbeddingProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'apiKey is required');
    }
    if (!config.modelId.trim()) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'modelId is required');
    }
    if (config.dimensions <= 0) {
      throw new ProviderConfigurationError(PROVIDER_ID, 'dimensions must be > 0');
    }
    this.modelId = config.modelId;
    this.dimensions = config.dimensions;
    this.client = config.client ?? new OpenAI({ apiKey: config.apiKey });
  }

  async embed(request: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse> {
    if (request.texts.length === 0) {
      return { vectors: [], inputTokens: 0, modelId: this.modelId };
    }

    // OpenAI 3-small is symmetric. Warn once if a caller expects asymmetric
    // behaviour they aren't getting.
    if (request.kind === 'query' && !this.warnedAboutAsymmetric) {
      this.warnedAboutAsymmetric = true;
      console.warn(
        `[${PROVIDER_ID}] request specifies kind='query' but ${this.modelId} is symmetric — input_type is ignored. Future asymmetric providers (e.g. Voyage) will honour this.`,
      );
    }

    // Pre-flight: trivially reject any individual text longer than our
    // tokenless estimate. We don't tokenise client-side (no tokenizer for
    // OpenAI's exact encoding here); rough proxy: characters / 3.5 ≈ tokens.
    // If a text exceeds the proxy, we raise rather than risk a silent
    // truncation at the API layer.
    for (const text of request.texts) {
      const approxTokens = Math.ceil(text.length / 3.5);
      if (approxTokens > MAX_INPUT_TOKENS) {
        throw new ContextLengthError(PROVIDER_ID, approxTokens, MAX_INPUT_TOKENS);
      }
    }

    const startedAt = Date.now();
    const vectors: number[][] = [];
    let totalInputTokens = 0;

    try {
      for (let i = 0; i < request.texts.length; i += BATCH_LIMIT) {
        const batch = request.texts.slice(i, i + BATCH_LIMIT);
        const response = await this.client.embeddings.create({
          model: this.modelId,
          input: [...batch],
          dimensions: this.dimensions,
        });

        // Response data is ordered by `index`. Sort defensively in case the
        // API reorders.
        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        for (const item of sorted) {
          if (item.embedding.length !== this.dimensions) {
            throw new ProviderError(
              PROVIDER_ID,
              `vector dimension mismatch — expected ${this.dimensions}, got ${item.embedding.length}`,
            );
          }
          vectors.push(item.embedding);
        }
        totalInputTokens += response.usage?.total_tokens ?? 0;
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
          region: REGION,
          ...(ctx.extractorVersionId !== undefined
            ? { extractorVersionId: ctx.extractorVersionId }
            : {}),
          metadata: {
            vectorCount: vectors.length,
            batchCount: Math.ceil(request.texts.length / BATCH_LIMIT),
          },
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
            region: REGION,
            failed: true,
            ...(ctx.extractorVersionId !== undefined
              ? { extractorVersionId: ctx.extractorVersionId }
              : {}),
          },
        )
        .catch(() => {});
      throw mapOpenAIError(err);
    }
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
      return new ContextLengthError(PROVIDER_ID, 0, MAX_INPUT_TOKENS, err);
    }
    if (status >= 500) return new ProviderUnavailableError(PROVIDER_ID, err);
    return new ProviderError(PROVIDER_ID, err.message, err);
  }
  if (err instanceof ProviderError) return err;
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

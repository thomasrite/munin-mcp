// Ollama embedding provider for the local/desktop runtime (P1).
//
// This file (with ollama-llm-provider.ts) is the ONLY place Ollama is called for
// embeddings — raw `fetch`, no SDK, against a LOCAL daemon (zero network). The
// default model is bge-m3, which returns 1024-dim vectors to match the engine's
// fixed schema dimension.
//
// FAIL-FAST on dimension mismatch: a local-mode index is only valid if every
// vector matches the schema's vector(N) column. If the configured model returns
// a different size (a common footgun when swapping local models), we throw
// rather than silently write vectors the DB will reject — wired to the same
// dimension contract the factory validates against SCHEMA_EMBEDDING_DIMENSIONS.
//
// Local embeddings live in a DIFFERENT vector space from the cloud embeddings:
// a local-mode corpus must be embedded AND queried with the same local model.
// Never mix a cloud-embedded corpus with local-mode queries.

import { asActorId } from '../graph/types';
import { ProviderError, ProviderUnavailableError } from './provider-errors';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';

const PROVIDER_ID = 'ollama';
const REGION = 'local';
const ACTOR = asActorId('provider:ollama');

export interface OllamaEmbeddingProviderConfig {
  readonly baseUrl: string; // e.g. http://localhost:11434
  readonly modelId: string; // e.g. bge-m3
  readonly dimensions: number; // must equal the schema's EMBEDDING_DIMENSIONS
  readonly fetchImpl?: typeof fetch; // injected for tests
  // Per-request budget (P2-10). Embeds are much quicker than generation, so
  // the default is tighter than the LLM's. Overridable via OLLAMA_TIMEOUT_MS.
  readonly timeoutMs?: number;
}

export const DEFAULT_OLLAMA_EMBED_TIMEOUT_MS = 30_000;

interface OllamaEmbeddingResponse {
  readonly embedding?: readonly number[];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 8192,
    maxBatchSize: 1, // /api/embeddings takes a single prompt; we loop
  };
  readonly dimensions: number;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: OllamaEmbeddingProviderConfig) {
    if (config.dimensions <= 0) {
      throw new ProviderError(PROVIDER_ID, 'dimensions must be > 0');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelId = config.modelId;
    this.dimensions = config.dimensions;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_OLLAMA_EMBED_TIMEOUT_MS;
  }

  async embed(request: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse> {
    if (request.texts.length === 0) {
      return { vectors: [], inputTokens: 0, modelId: this.modelId };
    }

    const startedAt = Date.now();
    const vectors: number[][] = [];
    try {
      for (const text of request.texts) {
        const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.modelId, prompt: text }),
          // Per-text budget (the loop embeds one prompt per request).
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new ProviderError(
            PROVIDER_ID,
            `/api/embeddings HTTP ${res.status}: ${detail.slice(0, 300)}`,
          );
        }
        const data = (await res.json()) as OllamaEmbeddingResponse;
        const vector = data.embedding;
        if (!vector || vector.length !== this.dimensions) {
          // FAIL-FAST: the local model's output dimension must match the schema.
          throw new ProviderError(
            PROVIDER_ID,
            `model '${this.modelId}' returned ${vector?.length ?? 'no'} dims, expected ${this.dimensions} — the local embedding model must match the engine vector dimension.`,
          );
        }
        vectors.push([...vector]);
      }
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
      throw asProviderError(err, this.timeoutMs);
    }

    await ctx.graphStore.insertLlmCall(
      { tenantId: ctx.tenantId, actor: ACTOR },
      {
        purpose: 'embedding',
        modelId: this.modelId,
        inputTokens: 0, // Ollama /api/embeddings does not report token usage
        cachedInputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startedAt,
        region: REGION,
        ...(ctx.extractorVersionId !== undefined
          ? { extractorVersionId: ctx.extractorVersionId }
          : {}),
        metadata: { vectorCount: vectors.length },
      },
    );

    return { vectors, inputTokens: 0, modelId: this.modelId };
  }
}

// A timeout (P2-10) is named explicitly so a wedged daemon reads as "wedged",
// not "not running".
function asProviderError(err: unknown, timeoutMs: number): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new ProviderError(
      PROVIDER_ID,
      `/api/embeddings timed out after ${timeoutMs}ms — the Ollama daemon is up but not responding (wedged or overloaded). Raise OLLAMA_TIMEOUT_MS for slow local hardware.`,
    );
  }
  return new ProviderUnavailableError(PROVIDER_ID, err);
}

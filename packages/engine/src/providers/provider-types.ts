// Provider interfaces for external AI services.
//
// All engine code that wants to call an LLM or generate embeddings goes
// through these interfaces. No other module imports `@anthropic-ai/sdk`,
// `openai`, or any other provider SDK directly. The architecture-reviewer
// flags violations.

import type { GraphStoreWriter } from '../graph/graph-store';
import type { DocumentId, ExtractorVersionId, TenantId } from '../graph/types';

// ---------------------------------------------------------------------------
// Capability declaration — surfaced so callers can branch on what a provider
// supports without having to know which implementation is loaded.
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  // True if the provider supports a cacheable system-prompt prefix.
  // Anthropic: true (ephemeral cache_control). Bedrock: true (cachePoint).
  // OpenAI LLM (not used here): automatic, surfaces as true.
  readonly promptCaching: boolean;

  // True if the provider distinguishes 'document' from 'query' embedding
  // inputs (asymmetric retrieval). OpenAI text-embedding-3-*: false.
  // Voyage: true. Cohere: true.
  readonly asymmetricEmbeddings: boolean;

  // Maximum input tokens per single text/message the provider accepts.
  readonly maxInputTokens: number;

  // Maximum number of inputs per embed() call.
  readonly maxBatchSize: number;
}

// ---------------------------------------------------------------------------
// Per-call context. Every provider call receives this so the provider can
// write its own `llm_calls` row for cost telemetry. Caller cannot forget.
// ---------------------------------------------------------------------------

export interface ProviderCallContext {
  readonly tenantId: TenantId;
  readonly purpose: 'extraction' | 'query' | 'embedding' | 'generation' | 'other';
  readonly graphStore: GraphStoreWriter;
  // Optional reference to the extractor version this call belongs to. Set by
  // the extractor in 1.6a so cost telemetry can be attributed per extractor.
  readonly extractorVersionId?: ExtractorVersionId;
  // Optional document context — populated for extraction and embedding
  // calls so per-document cost analysis works (migration 0003).
  readonly documentId?: DocumentId;
}

// ---------------------------------------------------------------------------
// LLM provider
// ---------------------------------------------------------------------------

export interface LLMMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

// Tool definition for structured-output extraction. The provider maps this
// to Anthropic's `tools` array, Bedrock's `toolConfig.tools`, etc.
//
// `inputSchema` is a JSON Schema describing the tool's expected input. The
// extractor builds this from the configuration's entity-type schemas.
// Ordering inside this object is canonical — callers must construct it
// deterministically so prompt caching keys remain stable across calls.
export interface LLMTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface LLMToolChoice {
  // 'auto' — model decides. 'any' — model must use any tool. 'tool' — model
  // must call this specific tool. 'none' — model cannot use tools.
  readonly type: 'auto' | 'any' | 'tool' | 'none';
  readonly name?: string;
}

// Cache tier — Anthropic supports both 5-minute ephemeral (cheaper to
// create, default) and 1-hour extended (more expensive to create, longer
// hit window) caches. Extended is opt-in for sustained workloads where
// the 5-minute TTL would expire between batches. Bedrock maps these to
// its own cachePoint TTL settings.
export type CacheTier = 'ephemeral' | 'extended';

export interface LLMRequest {
  // Optional override. If omitted, provider uses its configured default.
  readonly model?: string;
  readonly system: string;
  readonly messages: readonly LLMMessage[];
  // Mark the cacheable static prefix. With tools present, both the tools
  // array and the system block are marked as cache boundaries so partial
  // cache hits work when one changes but not the other.
  readonly cacheableSystemPrefix?: boolean;
  // Selects the cache tier when caching is requested. 'ephemeral' (5m,
  // default) is cheaper to create and suits batch workloads. 'extended'
  // (1h) costs more to create but stays warm longer — useful for sustained
  // trickle workloads. Ignored if cacheableSystemPrefix is not set.
  readonly cacheTier?: CacheTier;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  // Tools that the model may (or must) call. Empty/undefined = no tools.
  readonly tools?: readonly LLMTool[];
  readonly toolChoice?: LLMToolChoice;
}

// A single tool-use call in the model's response.
export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface LLMResponse {
  // Concatenated text content blocks (excluding tool_use blocks). May be
  // empty when the model called a tool without explanatory text.
  readonly text: string;
  // All tool_use blocks the model emitted, in document order. The parser
  // walks every block of the model's response, so a model that leads with
  // a brief "I'll extract..." text and then calls the tool surfaces both
  // here.
  readonly toolCalls: readonly LLMToolCall[];
  // Tokens billed as non-cached input. For Anthropic this includes both
  // regular input and cache-creation tokens (priced higher than regular).
  readonly inputTokens: number;
  // Tokens served from cache (cheap or free reads).
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'other';
}

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  // Configured default model. Callers can override per request.
  readonly defaultModel: string;

  complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Embedding provider
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  readonly texts: readonly string[];
  // 'document' for paragraphs being indexed; 'query' for search inputs.
  // Honoured by asymmetric providers (Voyage, Cohere); ignored by symmetric
  // providers (OpenAI text-embedding-3-*, Bedrock Titan).
  readonly kind: 'document' | 'query';
}

export interface EmbedResponse {
  readonly vectors: readonly (readonly number[])[];
  readonly inputTokens: number;
  readonly modelId: string;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  // Dimension of every vector returned. Must match the engine's
  // EMBEDDING_DIMENSIONS schema constant.
  readonly dimensions: number;
  readonly modelId: string;

  embed(request: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse>;
}

// ---------------------------------------------------------------------------
// Rerank provider (cross-encoder / LLM-judge). Re-scores an ALREADY-RETRIEVED,
// already-permission-filtered candidate set by precise query-document relevance,
// so the right document is pulled above a noisy hybrid-search cutoff. It NEVER
// fetches documents — it only re-orders the candidates the caller passes in, so
// it can never surface anything outside the caller's permissions.
// ---------------------------------------------------------------------------

export interface RerankDocument {
  // Caller-stable id (e.g. a paragraph id) — echoed back in the ranking.
  readonly id: string;
  readonly text: string;
}

export interface RerankRequest {
  readonly query: string;
  readonly documents: readonly RerankDocument[];
  // How many top results to return (the rest are dropped).
  readonly topK: number;
}

export interface RerankResult {
  readonly id: string;
  // Relevance score (higher = more relevant); provider-relative, used only to order.
  readonly score: number;
}

export interface RerankResponse {
  // The topK most relevant documents, highest score first.
  readonly ranking: readonly RerankResult[];
  readonly modelId: string;
}

export interface RerankProvider {
  readonly id: string;
  readonly modelId: string;
  // Max documents the provider can re-score in one call; callers cap to this.
  readonly maxDocuments: number;
  rerank(request: RerankRequest, ctx: ProviderCallContext): Promise<RerankResponse>;
}

// ---------------------------------------------------------------------------
// Aggregate the factory returns
// ---------------------------------------------------------------------------

export interface ProviderBundle {
  readonly llm: LLMProvider;
  readonly embedding: EmbeddingProvider;
  // Optional reranker (RERANK_PROVIDER). Absent → retrieval is not reranked.
  readonly rerank?: RerankProvider;
}

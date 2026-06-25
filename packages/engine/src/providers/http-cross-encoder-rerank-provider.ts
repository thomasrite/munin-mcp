// Self-hosted open cross-encoder RerankProvider over HTTP — a purpose-built
// reranker that re-scores candidates with a real cross-encoder (e.g. BAAI/
// bge-reranker-v2-m3), served by a LOCAL/UK-hosted inference endpoint. The
// UK-safe answer to the LLM-judge's discrimination ceiling: a cross-encoder reads
// the (query, document) PAIR jointly, so it can tell near-identical letters about
// DIFFERENT people apart — which an LLM judge ranking a numbered list cannot.
//
// It speaks the SAME /rerank wire contract as HuggingFace Text-Embeddings-
// Inference (TEI), so the SAME provider talks to a local dev server (tools/
// rerank-server, arm64-native via uv) OR a production TEI deployment (x86/Linux),
// region-of-choice (UK). No model SDK in-process: it only POSTs JSON over HTTP.
//
// AUDITED BOUNDARY: it re-orders ONLY the candidate documents handed to it (the
// caller already permission-filtered them). It never fetches documents, so it
// cannot surface anything outside the caller's clearance.

import { asActorId } from '../graph/types';
import { ProviderError } from './provider-errors';
import type {
  ProviderCallContext,
  RerankProvider,
  RerankRequest,
  RerankResponse,
  RerankResult,
} from './provider-types';

const PROVIDER_ID = 'cross-encoder';
const ACTOR = asActorId('provider:cross-encoder');
// Telemetry region tag — the endpoint runs on/near the host (local dev or a
// UK-hosted TEI), never US/Frankfurt. Recorded so cost reports show £0 (no tokens)
// and the bake-off can read per-rerank latency.
const REGION = 'local';

// TEI /rerank wire shapes.
interface TeiRerankItem {
  readonly index: number;
  readonly score: number;
}

export interface HttpCrossEncoderRerankProviderConfig {
  // The /rerank endpoint, e.g. 'http://localhost:8080/rerank'.
  readonly endpoint: string;
  // Display/telemetry model id, e.g. 'BAAI/bge-reranker-v2-m3'.
  readonly modelId: string;
  // Max candidates re-scored in one request (a real cross-encoder handles a wide
  // pool natively — this is just a sanity bound).
  readonly maxDocuments?: number;
  // Truncate each document to this many leading characters before sending. A
  // cross-encoder judges relevance from the document's lead (subject + topic),
  // and shorter sequences are FAR faster per pair — the dominant latency lever for
  // a self-hosted model. Default 512.
  readonly perDocChars?: number;
  // Fail fast: a rerank that exceeds this falls back to the fused order (best-
  // effort at the call site), so a slow endpoint never stalls a query.
  readonly timeoutMs?: number;
  // Injected for tests (defaults to the global fetch).
  readonly fetchImpl?: typeof fetch;
}

export class HttpCrossEncoderRerankProvider implements RerankProvider {
  readonly id = PROVIDER_ID;
  readonly modelId: string;
  readonly maxDocuments: number;
  private readonly endpoint: string;
  private readonly perDocChars: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpCrossEncoderRerankProviderConfig) {
    if (!config.endpoint.trim())
      throw new ProviderError(PROVIDER_ID, 'endpoint is required (RERANK_ENDPOINT)');
    if (!config.modelId.trim()) throw new ProviderError(PROVIDER_ID, 'modelId is required');
    this.endpoint = config.endpoint;
    this.modelId = config.modelId;
    this.maxDocuments = config.maxDocuments ?? 200;
    this.perDocChars = config.perDocChars ?? 512;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async rerank(request: RerankRequest, ctx: ProviderCallContext): Promise<RerankResponse> {
    const docs = request.documents.slice(0, this.maxDocuments);
    if (docs.length === 0) return { ranking: [], modelId: this.modelId };

    const startedAt = Date.now();
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: request.query,
          texts: docs.map((d) =>
            d.text.length > this.perDocChars ? d.text.slice(0, this.perDocChars) : d.text,
          ),
          truncate: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new ProviderError(PROVIDER_ID, `rerank endpoint returned HTTP ${res.status}`);
      }
      const items = (await res.json()) as readonly TeiRerankItem[];
      if (!Array.isArray(items)) {
        throw new ProviderError(PROVIDER_ID, 'rerank endpoint returned a non-array body');
      }

      // The endpoint returns items sorted most-relevant first; map index → id and
      // cap to topK. Defensive against out-of-range / duplicate indices.
      const ranking: RerankResult[] = [];
      const seen = new Set<number>();
      for (const item of items) {
        const idx = item?.index;
        if (!Number.isInteger(idx) || idx < 0 || idx >= docs.length || seen.has(idx)) continue;
        seen.add(idx);
        const doc = docs[idx];
        if (doc) ranking.push({ id: doc.id, score: item.score });
        if (ranking.length >= request.topK) break;
      }

      await this.recordTelemetry(ctx, Date.now() - startedAt, docs.length, false);
      return { ranking, modelId: this.modelId };
    } catch (err) {
      await this.recordTelemetry(ctx, Date.now() - startedAt, docs.length, true);
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        PROVIDER_ID,
        `rerank request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Record one telemetry row so cost reports show £0 (no tokens) and the bake-off
  // can read per-rerank latency. Best-effort: a telemetry failure never masks the
  // rerank result/error.
  private async recordTelemetry(
    ctx: ProviderCallContext,
    latencyMs: number,
    candidates: number,
    failed: boolean,
  ): Promise<void> {
    try {
      await ctx.graphStore.insertLlmCall(
        { tenantId: ctx.tenantId, actor: ACTOR },
        {
          purpose: 'other',
          modelId: this.modelId,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          latencyMs,
          region: REGION,
          ...(failed ? { failed: true } : {}),
          metadata: { rerank: true, candidates },
        },
      );
    } catch {
      // swallow — telemetry must not affect retrieval
    }
  }
}

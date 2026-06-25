// Embedding service — orchestrates calls to the embedding provider and
// writes resulting vectors to the GraphStore.
//
// The split of responsibilities:
//   - EmbeddingProvider (in src/providers): calls the external API, owns
//     batching and provider-specific error mapping
//   - EmbeddingService (here):              orchestrates ingestion-level
//     concerns — looking up paragraphs without embeddings, dispatching
//     batches to the provider, persisting via GraphStore, scoping by tenant
//
// In Phase 1.4 we expose two operations: embed a list of texts (returns
// vectors) and embed-and-store a list of paragraphs (writes via GraphStore).
// The worker-job wiring that enqueues these calls on paragraph insert
// lives in session 1.5.

import type { GraphStore } from '../graph/graph-store';
import { type ParagraphId, type TenantId, asActorId, internalBypass } from '../graph/types';
import type { EmbeddingProvider, ProviderCallContext } from '../providers';
import { mapWithConcurrency } from '../providers/resilience';

// How many paragraphs embed concurrently. Each is an independent unit so one
// permanently-failing paragraph (after the provider's retries) does not block the
// others — it is logged and the job re-queues for the failed ids.
const EMBED_CONCURRENCY = 8;

export interface EmbedParagraphsParams {
  readonly tenantId: TenantId;
  readonly paragraphIds: readonly ParagraphId[];
  readonly purpose?: ProviderCallContext['purpose'];
}

export interface EmbedQueryParams {
  readonly tenantId: TenantId;
  readonly text: string;
}

export class EmbeddingService {
  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly graphStore: GraphStore,
  ) {}

  // Fetch each paragraph (under INTERNAL_BYPASS because this is a system
  // operation that must see paragraphs regardless of the calling user's
  // tags), embed them in one provider call, persist via upsertEmbedding.
  // Returns the count of paragraphs embedded.
  async embedParagraphs(params: EmbedParagraphsParams): Promise<number> {
    if (params.paragraphIds.length === 0) return 0;

    const bypassCtx = {
      kind: 'bypass' as const,
      tenantId: params.tenantId,
      bypass: internalBypass(
        'embedding-service.embedParagraphs',
        'system embedding generation requires read access independent of caller tags',
      ),
      actor: asActorId('system:embedding-service'),
    };

    const paragraphs = [];
    for (const id of params.paragraphIds) {
      const p = await this.graphStore.getParagraph(bypassCtx, id);
      if (p) paragraphs.push(p);
    }
    if (paragraphs.length === 0) return 0;

    const writeCtx = { tenantId: params.tenantId, actor: asActorId('system:embedding-service') };
    const callCtx: ProviderCallContext = {
      tenantId: params.tenantId,
      purpose: params.purpose ?? 'embedding',
      graphStore: this.graphStore,
    };

    // Embed + store each paragraph as an INDEPENDENT, concurrent unit. The
    // provider already applies a per-call timeout + retry, so a paragraph either
    // succeeds, or permanently fails after retries (never hangs). A permanent
    // failure is logged and isolated — the other paragraphs still embed and persist
    // — and its id is collected. Idempotent upsert means re-running is safe.
    const outcomes = await mapWithConcurrency(paragraphs, EMBED_CONCURRENCY, async (paragraph) => {
      try {
        const { vectors, modelId } = await this.provider.embed(
          { texts: [paragraph.text], kind: 'document' },
          callCtx,
        );
        const vector = vectors[0];
        if (vector === undefined) {
          throw new Error('embedding provider returned no vector');
        }
        await this.graphStore.upsertEmbedding(writeCtx, {
          targetKind: 'paragraph',
          targetId: paragraph.id,
          modelId,
          vector,
          accessTags: paragraph.accessTags,
        });
        return { id: paragraph.id, ok: true as const };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Structured-enough diagnostic; no pino logger is plumbed into the engine
        // worker library (mirrors worker.ts). NOT swallowed silently — the id is
        // collected and surfaced below so the job re-queues it.
        console.warn(`[embedding-service] paragraph ${paragraph.id} failed to embed: ${reason}`);
        return { id: paragraph.id, ok: false as const };
      }
    });

    const failed = outcomes.filter((o) => !o.ok).map((o) => o.id);
    if (failed.length > 0) {
      // Surface so graphile-worker re-queues the job (bounded attempts) — the
      // successful paragraphs are already persisted (idempotent), so a re-run only
      // retries the failures. Never a silent drop.
      const sample = failed.slice(0, 5).join(', ');
      throw new Error(
        `embedding failed for ${failed.length}/${paragraphs.length} paragraph(s) after retries: ${sample}${failed.length > 5 ? ', …' : ''}`,
      );
    }
    return paragraphs.length;
  }

  // Embed a query string. Returns the vector without persisting (queries
  // are ephemeral).
  async embedQuery(
    params: EmbedQueryParams,
  ): Promise<{ vector: readonly number[]; modelId: string }> {
    const callCtx: ProviderCallContext = {
      tenantId: params.tenantId,
      purpose: 'query',
      graphStore: this.graphStore,
    };
    const { vectors, modelId } = await this.provider.embed(
      { texts: [params.text], kind: 'query' },
      callCtx,
    );
    if (!vectors[0]) throw new Error('embedding provider returned no vector for query');
    return { vector: vectors[0], modelId };
  }
}

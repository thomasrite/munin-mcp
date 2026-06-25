// Semantic-duplicate detection (P3a) — the post-embed counterpart to the
// lexical SimHash near-dup scan.
//
// Two documents can be duplicates without being lexically close (a re-worded
// policy, a translated or re-templated copy). Once a document is embedded, this
// detector compares its embedding CENTROID against the centroids of nearby
// documents and, when cosine similarity ≥ SEMANTIC_DUP_COSINE_THRESHOLD, records
// a document_duplicates(method='semantic') LINK. Like the near path: LINK, never
// merge or skip — both documents stay fully ingested and retrievable.
//
// The candidate set is BOUNDED: a single vector search over the document's
// centroid surfaces the nearest paragraphs, whose documents are the only
// candidates compared (capped at SEM_MAX_CANDIDATE_DOCS). This is O(1) vector
// searches per document, not O(corpus) centroid comparisons; an exhaustive
// all-pairs pass is deliberately NOT done.

import type { GraphStoreReader, GraphStoreWriter } from '../graph/graph-store';
import {
  type DocumentId,
  type ReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asParagraphId,
  internalBypass,
} from '../graph/types';

// Cosine similarity at/above which two documents are linked as semantic
// duplicates. 0.92 is tight enough to avoid linking merely topically-related
// documents while catching genuine re-wordings/re-templates.
export const SEMANTIC_DUP_COSINE_THRESHOLD = 0.92;

// How many nearest paragraphs the candidate vector search returns. Bounds the
// candidate document set surfaced for centroid comparison.
const SEM_CANDIDATE_K = 50;
// Upper bound on candidate documents actually compared per detection run.
const SEM_MAX_CANDIDATE_DOCS = 10;

export interface SemanticDuplicateDetectorDeps {
  readonly reader: GraphStoreReader;
  readonly writer: GraphStoreWriter;
}

export interface DetectForDocumentParams {
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
  readonly modelId: string;
}

// Thrown when the document's paragraphs exist but none are embedded yet — the
// caller (worker job) should retry so detection runs once embedding completes.
export class EmbeddingsNotReadyError extends Error {
  constructor(public readonly documentId: DocumentId) {
    super(`document ${documentId} has paragraphs but no embeddings yet; retry after embedding`);
    this.name = 'EmbeddingsNotReadyError';
  }
}

export class SemanticDuplicateDetector {
  constructor(private readonly deps: SemanticDuplicateDetectorDeps) {}

  // Detect and LINK semantic duplicates of `documentId`. Returns the linked
  // counterpart document ids. Idempotent at the store (the duplicate link is
  // recorded under the (tenant, doc, dup_of, method) natural key).
  async detectForDocument(params: DetectForDocumentParams): Promise<readonly DocumentId[]> {
    // System operation: detection must span the full tenant corpus regardless of
    // any user's tags. The resulting links are EXPOSED only via the access-gated
    // findDuplicatesForDocument, so the bypass never widens what a user can see.
    const ctx: ReadContext = {
      kind: 'bypass',
      tenantId: params.tenantId,
      bypass: internalBypass(
        'semantic-dedup.detect',
        'semantic-duplicate detection reads document vectors across the tenant corpus before linking',
      ),
      actor: asActorId('system:semantic-dedup'),
    };
    const writeCtx: WriteContext = {
      tenantId: params.tenantId,
      actor: asActorId('system:semantic-dedup'),
    };

    const centroidSelf = await this.documentCentroid(ctx, params.documentId, params.modelId);
    if (centroidSelf === null) {
      // No paragraphs at all → nothing to do. Paragraphs-but-no-embeddings →
      // signal the caller to retry once embedding has run.
      const paras = await this.deps.reader.findParagraphsByDocument(ctx, params.documentId);
      if (paras.length > 0) throw new EmbeddingsNotReadyError(params.documentId);
      return [];
    }

    // Bounded candidate discovery: nearest paragraphs to the centroid → their
    // documents (excluding self), capped.
    const hits = await this.deps.reader.searchByVector(ctx, {
      modelId: params.modelId,
      k: SEM_CANDIDATE_K,
      queryVector: centroidSelf,
    });
    const paragraphTargetIds = hits
      .filter((h) => h.targetKind === 'paragraph')
      .map((h) => h.targetId);
    const candidateParas = await this.deps.reader.getParagraphsByIds(
      ctx,
      paragraphTargetIds.map((id) => asParagraphId(id)),
    );
    const candidateDocIds: DocumentId[] = [];
    const seen = new Set<string>();
    for (const p of candidateParas) {
      if (p.documentId === params.documentId) continue;
      if (seen.has(p.documentId)) continue;
      seen.add(p.documentId);
      candidateDocIds.push(p.documentId);
      if (candidateDocIds.length >= SEM_MAX_CANDIDATE_DOCS) break;
    }

    const linked: DocumentId[] = [];
    for (const candidateId of candidateDocIds) {
      const centroidOther = await this.documentCentroid(ctx, candidateId, params.modelId);
      if (centroidOther === null) continue;
      const cosine = cosineSimilarity(centroidSelf, centroidOther);
      if (cosine >= SEMANTIC_DUP_COSINE_THRESHOLD) {
        // Symmetric relationship → canonicalise the pair (min,max) so the run for
        // either document records the SAME row, idempotent across both.
        const [a, b] = canonicalPair(params.documentId, candidateId);
        await this.deps.writer.recordDocumentDuplicate(writeCtx, {
          documentId: a,
          duplicateOfDocumentId: b,
          method: 'semantic',
          score: cosine,
        });
        linked.push(candidateId);
      }
    }
    return linked;
  }

  // Mean of the document's live paragraph embedding vectors, normalised to unit
  // length. null when the document has no embeddings.
  private async documentCentroid(
    ctx: ReadContext,
    documentId: DocumentId,
    modelId: string,
  ): Promise<number[] | null> {
    const paras = await this.deps.reader.findParagraphsByDocument(ctx, documentId);
    if (paras.length === 0) return null;
    const embeddings = await this.deps.reader.getEmbeddingsByTargets(ctx, {
      targetKind: 'paragraph',
      targetIds: paras.map((p) => p.id),
      modelId,
    });
    if (embeddings.length === 0) return null;
    return normalisedCentroid(embeddings.map((e) => e.vector));
  }
}

// --- vector math (engine-generic) ------------------------------------------

function normalisedCentroid(vectors: ReadonlyArray<readonly number[]>): number[] | null {
  const first = vectors[0];
  if (!first) return null;
  const dim = first.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
  }
  const mean = sum.map((s) => s / vectors.length);
  return normalise(mean);
}

function normalise(v: readonly number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return [...v];
  return v.map((x) => x / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function canonicalPair(x: DocumentId, y: DocumentId): [DocumentId, DocumentId] {
  return String(x) <= String(y) ? [x, y] : [y, x];
}

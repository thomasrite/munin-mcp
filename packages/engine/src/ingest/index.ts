// Document ingestion pipeline.

export * from './parsers';
export { chunkBlocks, segmentSentences, estimateTokens } from './chunker';
export type { ChunkOptions, ChunkResult } from './chunker';
export { sanitiseText } from './text-sanitise';
export { detectFromBytes, detectFromFilename } from './mime-detection';
export type { MimeDetection } from './mime-detection';
export {
  IngestionPipeline,
  type IngestionPipelineOptions,
  type IngestRequest,
  type IngestSummary,
} from './ingestion-pipeline';
export {
  sha256OfBytes,
  findExistingDocumentByHash,
} from './idempotency';
export {
  NEAR_DUP_HAMMING_THRESHOLD,
  computeSimhash,
  hammingDistance,
  simhashSimilarity,
  areNearDuplicates,
} from './simhash';
export {
  SemanticDuplicateDetector,
  type SemanticDuplicateDetectorDeps,
  type DetectForDocumentParams,
  EmbeddingsNotReadyError,
  SEMANTIC_DUP_COSINE_THRESHOLD,
  cosineSimilarity,
} from './semantic-dedup';

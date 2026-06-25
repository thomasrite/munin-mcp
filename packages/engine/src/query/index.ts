// Query layer: semantic search, graph expansion, grounded answer synthesis.
export {
  QueryPipeline,
  type QueryPipelineOptions,
  type AnswerSource,
  type AnswerOverSourcesRequest,
} from './query-pipeline';
// ContextRetriever — the single, reusable, permission-correct CONTEXT SEAM
// (classify → vector OR resolve+gather → rank → return). Retrieval only; no
// answer synthesis. Every caller (QueryPipeline, web, future API) routes through it.
export {
  ContextRetriever,
  type ContextRequest,
  type ContextRetrieverOptions,
  type ContextRetrievalOverrides,
  type GroundedContext,
  type ContextSource,
  type ContextCompleteness,
  type GatheredContextSources,
  type IdentityRouting,
  type RetrievalMethod,
} from './context-retriever';
export type {
  AnswerCompleteness,
  Citation,
  ContradictionNote,
  ContradictionSide,
  QueryRequest,
  QueryResult,
  QueryStatus,
} from './types';
// Question classification (G1 / F31) — entity-centric vs open, routes on
// entity-presence. Pure, generic, vertical-agnostic.
export {
  classifyQuestion,
  type ClassifyQuestionInput,
  type QuestionClassification,
} from './classify-question';
// Query-time entity resolution (M1.1) — pure, generic, vertical-agnostic.
export {
  resolveEntities,
  type ResolvableEntity,
  type LogicalCluster,
  type ResolutionResult,
  type ResolutionOptions,
} from './resolution';
// Gather-by-identity (M1.2) — key-led, permission-correct record assembly.
export {
  gatherByIdentity,
  type GatherTarget,
  type GatherOptions,
  type GatheredRecords,
} from './gather';
// Disambiguation contract (M1.3) — present → pick → re-gather; pure, generic.
export {
  buildDisambiguation,
  selectCandidate,
  gatherTargetForCandidate,
  gatherTargetForCluster,
  type DisambiguationCandidate,
  type DisambiguationGroup,
  type DisambiguationResult,
} from './disambiguation';
// Grounded document generation (M2.1) — claim-level grounded, fail-closed,
// completeness-honest; consumes a gathered record set, reads nothing.
export {
  generateDocument,
  GenerationTruncatedError,
  type GenerateRequest,
  type GenerationSection,
  type GenerationSource,
  type GeneratedDocument,
  type GeneratedCitation,
  type GeneratedClaim,
  type GeneratedSectionResult,
  type CompletenessDisposition,
  type GenerationStatus,
} from './generate';
// Template executor (M2.2) — DocumentTemplate + gather → grounded structured doc.
export {
  generateFromTemplate,
  type TemplateGenerateRequest,
  type TemplateDocument,
  type RenderedSection,
  type TemplateDocumentStatus,
} from './generate-from-template';
export {
  assembleGenerationPrompt,
  GENERATION_TOOL_NAME,
  GENERATION_PROMPT_VERSION,
  NO_EVIDENCE_DOCUMENT_MESSAGE,
  type AssembledGenerationPrompt,
} from './generation-prompt';
export {
  ANSWER_TOOL_NAME,
  ANSWER_PROMPT_VERSION,
  NO_EVIDENCE_MESSAGE,
  assembleAnswerPrompt,
  type AssembledAnswerPrompt,
} from './answer-prompt';
// Contradiction detection (P3b) — the static, cache-safe "sources disagree"
// prompt; the cacheable prefix carries no tenant content.
export {
  CONTRADICTION_TOOL_NAME,
  CONTRADICTION_PROMPT_VERSION,
  assembleContradictionPrompt,
  type AssembledContradictionPrompt,
} from './contradiction-prompt';
// Contradiction machinery (P3b) — render the detection user turn, defensively
// parse the tool output, and validate every side against existing grounded
// citations (fail-closed). Pure + DB-/LLM-free.
export {
  renderContradictionUserMessage,
  parseContradictionInput,
  validateConflicts,
  adjudicateConflicts,
  type RawConflict,
  type RawConflictSide,
  type ValidatedConflict,
  type ValidatedSide,
} from './contradiction';
export {
  buildGroundingContext,
  estimateTokens,
  type GroundingCandidate,
  type GroundingContext,
  type GroundingOptions,
  type GroundedSource,
} from './grounding';
export { verifyQuoteGrounding, type QuoteGroundingOptions } from './faithfulness';
export { reconcileMarkers, type MarkerCitation, type Reconciled } from './marker-reconcile';
export {
  QueryAuditor,
  extractClaim,
  type QueryAuditorOptions,
  type AuditParams,
  type AuditResult,
  type CitationVerdict,
} from './query-auditor';
// The adversarial corpus is test-only fixture data; tests import it directly
// from the co-located adversarial fixture module. It is intentionally not part
// of any public surface and is excluded from the published build.

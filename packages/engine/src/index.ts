// @muninhq/engine — the vertical-agnostic core's PUBLIC API.
//
// This file is the single frozen surface that Phase 2 (the Next.js web app) and
// the worker build against. Anything not exported here is an engine internal
// and may change without notice; importing it from a deep path is a layering
// violation the architecture-reviewer flags.
//
// STABILITY CONTRACT (this is an internal workspace package, so "frozen" means
// disciplined, not immutable. for the full rules):
//   • Non-breaking, do freely: add a new export; add a method or an OPTIONAL
//     parameter; widen a return type additively.
//   • Breaking, requires a deliberate decision + a same-change update to
//     the engine API notes: remove or rename an export; change a signature
//     incompatibly; make an optional parameter required; narrow a type; change
//     documented runtime or permission semantics.
//
// Ops-only and adversarial-testing surfaces are intentionally NOT here; reach
// them via the explicit `@muninhq/engine/<subpath>` exports (see package.json).

// --- Query: grounded, cited question answering ----------------------------
export { QueryPipeline } from './query/query-pipeline';
// Honest-counting guard — a generic detector callers can reuse to recognise
// count/aggregation questions the Q&A path declines (rather than miscount).
export { COUNT_DECLINE_MESSAGE, isAggregationQuestion } from './query/aggregation-guard';
export type {
  QueryPipelineOptions,
  AnswerSource,
  AnswerOverSourcesRequest,
} from './query/query-pipeline';
// ContextRetriever — the single, reusable, permission-correct CONTEXT SEAM
// ("own the layer"): classify → vector OR resolve+gather → rank → return ranked,
// permission-filtered ContextSource[] + metadata. Retrieval only — no answer
// synthesis (that is QueryPipeline). Used by the web ask/generate actions and by
// any future API or agent that needs context for an LLM.
export { ContextRetriever } from './query/context-retriever';
export type {
  ContextRequest,
  ContextRetrieverOptions,
  ContextRetrievalOverrides,
  GroundedContext,
  ContextSource,
  ContextCompleteness,
  GatheredContextSources,
  IdentityRouting,
  RetrievalMethod,
} from './query/context-retriever';
export type {
  AnswerCompleteness,
  Citation,
  ContradictionNote,
  ContradictionSide,
  QueryRequest,
  QueryResult,
  QueryStatus,
} from './query/types';
// Question classification (G1 / F31) — entity-centric vs open; routes on
// entity-presence (resolve + name-mention), not phrasing. Pure, generic.
export {
  classifyQuestion,
  type ClassifyQuestionInput,
  type QuestionClassification,
} from './query/classify-question';
// Query-time entity resolution (M1.1) — pure, generic, vertical-agnostic.
export {
  resolveEntities,
  type ResolvableEntity,
  type LogicalCluster,
  type ResolutionResult,
  type ResolutionOptions,
} from './query/resolution';
// Gather-by-identity (M1.2) — key-led, permission-correct record assembly.
export {
  gatherByIdentity,
  type GatherTarget,
  type GatherOptions,
  type GatheredRecords,
} from './query/gather';
// Disambiguation contract (M1.3) — present → pick → re-gather; pure, generic.
export {
  buildDisambiguation,
  selectCandidate,
  gatherTargetForCandidate,
  gatherTargetForCluster,
  type DisambiguationCandidate,
  type DisambiguationGroup,
  type DisambiguationResult,
} from './query/disambiguation';
// Subject → gather-target resolution — the SINGLE seam both the entity-centric
// retriever and the web generate action route through (no duplicated sequence).
export {
  resolveSubjectToGatherTarget,
  loadResolvableSubjects,
  type GatherResolution,
  type ResolveSubjectInput,
  type ResolvableSubjects,
} from './query/resolve-target';
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
} from './query/generate';
// Template executor (M2.2) — DocumentTemplate + gather → grounded structured doc.
export {
  generateFromTemplate,
  type TemplateGenerateRequest,
  type TemplateDocument,
  type RenderedSection,
  type TemplateDocumentStatus,
} from './query/generate-from-template';
export {
  assembleGenerationPrompt,
  GENERATION_TOOL_NAME,
  GENERATION_PROMPT_VERSION,
  NO_EVIDENCE_DOCUMENT_MESSAGE,
  type AssembledGenerationPrompt,
} from './query/generation-prompt';
// Quote-grounding primitive (1.7b) — deterministic, fail-closed faithfulness check.
export { verifyQuoteGrounding, type QuoteGroundingOptions } from './query/faithfulness';
// Faithfulness auditor (G2) — off-path SEMANTIC support check (does the cited
// paragraph support the claim?). Opt-in / offline; never a hot-path gate.
export {
  QueryAuditor,
  extractClaim,
  type QueryAuditorOptions,
  type AuditParams,
  type AuditResult,
  type CitationVerdict,
} from './query/query-auditor';

// --- Ingestion: documents → blob + paragraphs, embeddings enqueued --------
export { IngestionPipeline } from './ingest/ingestion-pipeline';
export type {
  IngestionPipelineOptions,
  IngestRequest,
  IngestSummary,
} from './ingest/ingestion-pipeline';
// The canonical source-code extension set the engine can parse as code.
// Re-exported so connectors can build their default ingest allowlist from a
// single source of truth (connector → engine is the only legal direction).
export { CODE_FILE_EXTENSIONS } from './ingest/parsers';

// --- Extraction: configuration-driven graph extraction via tool_use -------
export { Extractor } from './extract/extractor';
export type { ExtractorOptions, ExtractionResult } from './extract/extractor';
// EXTRACTION_MODEL env knob — selects the extraction model independently of the
// answer model; UNSET → provider default (local Ollama path unaffected).
export { resolveExtractionModelId } from './extract/extraction-model';

// --- Graph: the only data-access path (interfaces, adapter, types, errors)-
// graph/index re-exports the branded IDs + as*/new* helpers, contexts,
// internalBypass, the domain + query/page types, the GraphStore interfaces,
// PostgresGraphStore, and the typed errors — the complete data-access surface.
export * from './graph';

// --- Providers: the AI-provider abstraction (the residency mechanism) -----
// interfaces + request/response types + ProviderCallContext/ProviderBundle,
// the env factory, the concrete dev impls, and provider errors.
export * from './providers';

// --- Blob storage ---------------------------------------------------------
export * from './blob';

// --- Right-to-erasure (P6b): the public per-document erasure orchestrator -----
// DB hard-delete (zero orphans, in-tx audit) then verified blob delete, with a
// content-free receipt. The web + any future API/connector share this one path.
export * from './erasure';

// --- Data retention (G2a, F55): the tenant-scoped TTL sweep -----------------
// Scrub-in-place of expired content (the row skeleton + audit trail survive);
// one content-free audit row per run. Worker job (hosted) + CLI (local) share it.
export * from './retention';

// --- Tenancy (D3): control-plane tenant resolution + per-tenant operational
// metadata (org units, role bindings, user assignments). Generic — the engine
// stores opaque rows; meaning lives in configuration.
export * from './tenancy';

// --- Learning (P5a): per-(tenant, actor) preference capture. The LearningStore
// is a SEPARATE metadata adapter (NOT graph facts, no access-tag reads); rules
// are opaque to the engine and reach generation only as a caller-supplied
// user-message string (cache-safe). Personal-scoped only; shared promotion is P5b.
export * from './learning';

// --- Configuration: the loader + the config/eval type surface -------------
// One import site for Phase 2: configuration types come from here, not from a
// direct @muninhq/shared import.
export {
  loadConfigurationFromPackage,
  loadConfigurationWithResolver,
  composeTenantConfiguration,
  composeConfiguration,
  computeCompositeHash,
  computeSchemaHash,
  ConfigurationCompositionError,
  MANAGE_TENANT,
  REVIEW_CORRECTIONS,
} from './config';
export type { ConfigModuleLoader } from './config';
export type {
  Configuration,
  ComposedConfiguration,
  Overlay,
  EntityTypeDefinition,
  EntityTypeExtension,
  RelationshipTypeDefinition,
  RoleDefinition,
  QueryTemplate,
  TerminologyMap,
  TagExpander,
  TagExpansionContext,
  ConnectorBinding,
  FewShotExample,
  EvalGroundTruth,
  EvalQuestion,
} from './config';

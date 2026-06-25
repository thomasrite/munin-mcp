// Eval surface for @muninhq/config-personal: the synthetic corpus, the
// hand-authored ground truth, and the pure scorer. Live (token-spending)
// runs live in munin-mcp as providers-gated suites.

export { type PersonalEvalDoc, paragraphsOf, personalEvalCorpus } from './corpus';
export {
  type PersonalEvalDocTruth,
  type PersonalEvalEntity,
  type PersonalEvalRelationship,
  personalGroundTruth,
  personalKeyProperties,
} from './ground-truth';
export {
  type ExtractedEntityLike,
  type ExtractedRelationshipLike,
  type PersonalEvalScore,
  type TypeScore,
  normaliseKey,
  scoreExtraction,
} from './score';
// Q&A leg (leg 2): the question matrix + the pure answer/citation/no-fabrication scorer.
export {
  type PersonalQuestion,
  personalGenerationSubjects,
  personalQuestionMatrix,
} from './question-matrix';
export {
  type QaLegScore,
  type QaQuestionScore,
  type QaResult,
  type ResolvedCitation,
  aggregateQaScores,
  scoreQaAnswer,
} from './qa-score';
// Generation leg (leg 3): the pure structure-match + grounding scorer.
export {
  type GeneratedSectionObservation,
  type GenerationLegScore,
  type GenerationObservation,
  type GenerationScore,
  aggregateGenerationScores,
  scoreGeneration,
} from './generation-score';

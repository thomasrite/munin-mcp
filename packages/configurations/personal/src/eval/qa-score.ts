// Pure scorer for the personal Q&A leg. Given a question's ground truth and the
// pipeline's resolved result (status + answer text + citations already mapped to
// corpus paragraphs by the harness), it judges three independent things:
//
//   • answerCorrect  — the answer is 'answered' AND contains every expected fact
//                      (case-insensitive substring). Accuracy of the prose.
//   • citationCorrect — at least one citation points at the EXACT expected
//                       (docFile, paragraphIndex). The right source, not just
//                       *a* source. `null` when the question declares no source
//                       (the negatives) so it never dilutes the citation metric.
//   • honest         — the status matches the expected status. For a negative
//                      (expectedStatus 'no_evidence') this IS the no-fabrication
//                      check: answering an unanswerable question is a fabrication.
//
// Pure: no engine, no DB, no provider. The harness resolves citation paragraph
// ids to (docFile, paragraphIndex) tuples and feeds them here.

import type { PersonalQuestion } from './question-matrix';

// A citation resolved to its corpus location by the harness.
export interface ResolvedCitation {
  readonly docFile: string;
  readonly paragraphIndex: number;
}

export interface QaResult {
  readonly status: 'answered' | 'no_evidence';
  readonly answerText: string;
  readonly citations: readonly ResolvedCitation[];
}

export interface QaQuestionScore {
  readonly id: string;
  readonly expectedStatus: 'answered' | 'no_evidence';
  readonly actualStatus: 'answered' | 'no_evidence';
  readonly honest: boolean; // status matches expectation (no-fabrication for negatives)
  readonly answerCorrect: boolean; // answered + all expected facts present
  readonly factsMatched: number;
  readonly factsExpected: number;
  // null when the question declares no expected source (negatives) — excluded
  // from the citation-accuracy aggregate.
  readonly citationCorrect: boolean | null;
}

function answerContains(answer: string, fact: string): boolean {
  return answer.toLowerCase().includes(fact.toLowerCase());
}

export function scoreQaAnswer(q: PersonalQuestion, result: QaResult): QaQuestionScore {
  const honest = result.status === q.expectedStatus;

  const factsExpected = q.expectedFacts.length;
  const factsMatched = q.expectedFacts.filter((f) => answerContains(result.answerText, f)).length;
  const answerCorrect = result.status === 'answered' && factsMatched === factsExpected;

  let citationCorrect: boolean | null = null;
  if (q.expectedSource) {
    const want = q.expectedSource;
    citationCorrect = result.citations.some(
      (c) => c.docFile === want.docFile && c.paragraphIndex === want.paragraphIndex,
    );
  }

  return {
    id: q.id,
    expectedStatus: q.expectedStatus,
    actualStatus: result.status,
    honest,
    answerCorrect,
    factsMatched,
    factsExpected,
    citationCorrect,
  };
}

export interface QaLegScore {
  readonly total: number;
  // Over the answered-expected questions: status answered AND facts present.
  readonly answerable: number;
  readonly answerAccurate: number;
  // Over answered-expected questions that declare a source: cited the right one.
  readonly withSource: number;
  readonly citationAccurate: number;
  // Over the negative (no_evidence-expected) questions: declined honestly.
  readonly negatives: number;
  readonly noFabrication: number;
  readonly perQuestion: readonly QaQuestionScore[];
}

// Aggregate per-question scores into the leg-level Q&A numbers the scorecard prints.
export function aggregateQaScores(scores: readonly QaQuestionScore[]): QaLegScore {
  const positives = scores.filter((s) => s.expectedStatus === 'answered');
  const negatives = scores.filter((s) => s.expectedStatus === 'no_evidence');
  const withSource = positives.filter((s) => s.citationCorrect !== null);

  return {
    total: scores.length,
    answerable: positives.length,
    answerAccurate: positives.filter((s) => s.answerCorrect).length,
    withSource: withSource.length,
    citationAccurate: withSource.filter((s) => s.citationCorrect === true).length,
    negatives: negatives.length,
    noFabrication: negatives.filter((s) => s.honest).length,
    perQuestion: scores,
  };
}

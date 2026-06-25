import { describe, expect, it } from 'vitest';

import { type QaQuestionScore, aggregateQaScores, scoreQaAnswer } from './qa-score';
import type { PersonalQuestion } from './question-matrix';

const answered: PersonalQuestion = {
  id: 'q1',
  question: 'Who wrote it?',
  expectedFacts: ['Sefa Adeyemi'],
  expectedSource: { docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 1 },
  expectedStatus: 'answered',
};

const negative: PersonalQuestion = {
  id: 'q-neg',
  question: 'Capital of France?',
  expectedFacts: [],
  expectedStatus: 'no_evidence',
};

describe('scoreQaAnswer — answered question', () => {
  it('credits a correct answer citing the right paragraph', () => {
    const s = scoreQaAnswer(answered, {
      status: 'answered',
      answerText: 'It was written by Sefa Adeyemi [1].',
      citations: [{ docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 1 }],
    });
    expect(s.honest).toBe(true);
    expect(s.answerCorrect).toBe(true);
    expect(s.citationCorrect).toBe(true);
  });

  it('is case-insensitive on the expected fact', () => {
    const s = scoreQaAnswer(answered, {
      status: 'answered',
      answerText: 'sefa adeyemi wrote it.',
      citations: [{ docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 1 }],
    });
    expect(s.answerCorrect).toBe(true);
  });

  it('marks citation wrong when the cited paragraph is a DIFFERENT one (not just any citation)', () => {
    const s = scoreQaAnswer(answered, {
      status: 'answered',
      answerText: 'Sefa Adeyemi.',
      // right doc, wrong paragraph
      citations: [{ docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 2 }],
    });
    expect(s.answerCorrect).toBe(true);
    expect(s.citationCorrect).toBe(false);
  });

  it('fails answerCorrect when an expected fact is missing', () => {
    const s = scoreQaAnswer(answered, {
      status: 'answered',
      answerText: 'A book about attention.',
      citations: [{ docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 1 }],
    });
    expect(s.answerCorrect).toBe(false);
    expect(s.factsMatched).toBe(0);
    expect(s.factsExpected).toBe(1);
  });

  it('fails answerCorrect when the pipeline wrongly declined', () => {
    const s = scoreQaAnswer(answered, {
      status: 'no_evidence',
      answerText: '',
      citations: [],
    });
    expect(s.honest).toBe(false);
    expect(s.answerCorrect).toBe(false);
  });
});

describe('scoreQaAnswer — negative question (no-fabrication)', () => {
  it('honest when it declines, citationCorrect is null (excluded)', () => {
    const s = scoreQaAnswer(negative, { status: 'no_evidence', answerText: '', citations: [] });
    expect(s.honest).toBe(true);
    expect(s.citationCorrect).toBeNull();
  });

  it('NOT honest when it fabricates an answer', () => {
    const s = scoreQaAnswer(negative, {
      status: 'answered',
      answerText: 'Paris.',
      citations: [{ docFile: 'whatever.md', paragraphIndex: 0 }],
    });
    expect(s.honest).toBe(false);
  });
});

describe('aggregateQaScores', () => {
  it('separates answer-accuracy, citation-accuracy and no-fabrication', () => {
    const scores: QaQuestionScore[] = [
      scoreQaAnswer(answered, {
        status: 'answered',
        answerText: 'Sefa Adeyemi',
        citations: [{ docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 1 }],
      }),
      scoreQaAnswer(negative, { status: 'no_evidence', answerText: '', citations: [] }),
    ];
    const agg = aggregateQaScores(scores);
    expect(agg.total).toBe(2);
    expect(agg.answerable).toBe(1);
    expect(agg.answerAccurate).toBe(1);
    expect(agg.withSource).toBe(1);
    expect(agg.citationAccurate).toBe(1);
    expect(agg.negatives).toBe(1);
    expect(agg.noFabrication).toBe(1);
  });
});

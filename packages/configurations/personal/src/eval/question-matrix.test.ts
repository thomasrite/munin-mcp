import { describe, expect, it } from 'vitest';

import { paragraphsOf, personalEvalCorpus } from './corpus';
import { personalGroundTruth } from './ground-truth';
import { personalGenerationSubjects, personalQuestionMatrix } from './question-matrix';

// These checks need no provider — they validate the matrix against the corpus
// it scores, so a corpus edit that moves a paragraph (or a typo'd expected fact)
// fails here rather than silently scoring the wrong span in the live harness.

const docByFile = new Map(personalEvalCorpus.map((d) => [d.file, d]));

describe('personalQuestionMatrix', () => {
  it('has at least one negative (no_evidence) case — the no-fabrication probe', () => {
    const negatives = personalQuestionMatrix.filter((q) => q.expectedStatus === 'no_evidence');
    expect(negatives.length).toBeGreaterThanOrEqual(1);
    // A negative declares no source and no facts (nothing in the corpus to cite).
    for (const q of negatives) {
      expect(q.expectedSource).toBeUndefined();
      expect(q.expectedFacts).toHaveLength(0);
    }
  });

  it('every answered question points at a real corpus paragraph', () => {
    for (const q of personalQuestionMatrix) {
      if (q.expectedStatus !== 'answered') continue;
      expect(q.expectedSource, `${q.id} must declare a source`).toBeDefined();
      const src = q.expectedSource;
      if (!src) continue;
      const doc = docByFile.get(src.docFile);
      expect(doc, `${q.id}: unknown doc ${src.docFile}`).toBeDefined();
      if (!doc) continue;
      const paras = paragraphsOf(doc);
      expect(src.paragraphIndex, `${q.id}: paragraph index out of range`).toBeLessThan(
        paras.length,
      );
    }
  });

  it('the expected facts appear verbatim in the cited paragraph (truth is grounded)', () => {
    for (const q of personalQuestionMatrix) {
      if (q.expectedStatus !== 'answered' || !q.expectedSource) continue;
      const doc = docByFile.get(q.expectedSource.docFile);
      if (!doc) continue;
      const paragraph = paragraphsOf(doc)[q.expectedSource.paragraphIndex] ?? '';
      const lower = paragraph.toLowerCase();
      for (const fact of q.expectedFacts) {
        expect(
          lower.includes(fact.toLowerCase()),
          `${q.id}: fact "${fact}" not found in cited paragraph`,
        ).toBe(true);
      }
    }
  });

  it('has unique ids', () => {
    const ids = personalQuestionMatrix.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('personalGenerationSubjects', () => {
  it('every subject is a Person in the ground truth (gatherable after extraction)', () => {
    const persons = new Set(
      personalGroundTruth.flatMap((d) =>
        d.entities.filter((e) => e.type === 'Person').map((e) => e.key),
      ),
    );
    for (const subject of personalGenerationSubjects) {
      expect(persons.has(subject), `${subject} is not a Person in the corpus ground truth`).toBe(
        true,
      );
    }
  });
});

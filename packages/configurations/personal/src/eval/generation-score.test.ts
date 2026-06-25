import { describe, expect, it } from 'vitest';

import {
  type GenerationObservation,
  aggregateGenerationScores,
  scoreGeneration,
} from './generation-score';

const HEADINGS = ['Overview', 'Projects & collaborations'];

function obs(over: Partial<GenerationObservation> = {}): GenerationObservation {
  return {
    subject: 'Callum Reyes',
    status: 'generated',
    expectedHeadings: HEADINGS,
    sections: [
      { heading: 'Overview', claimCount: 2, gap: false },
      { heading: 'Projects & collaborations', claimCount: 1, gap: false },
    ],
    regroundVerdicts: [true, true, true],
    droppedClaims: 0,
    recordCount: 3,
    ...over,
  };
}

describe('scoreGeneration', () => {
  it('a fully grounded, well-structured doc passes', () => {
    const s = scoreGeneration(obs());
    expect(s.structurePreserved).toBe(true);
    expect(s.sectionsFilled).toBe(2);
    expect(s.sectionsTotal).toBe(2);
    expect(s.survivingClaims).toBe(3);
    expect(s.regroundedClaims).toBe(3);
    expect(s.ungroundedSurvivors).toBe(0);
    expect(s.groundingPass).toBe(true);
  });

  it('FAILS grounding when a surviving claim does not re-ground (fail-closed bug)', () => {
    const s = scoreGeneration(obs({ regroundVerdicts: [true, false, true] }));
    expect(s.ungroundedSurvivors).toBe(1);
    expect(s.groundingPass).toBe(false);
  });

  it('breaks structure when a heading is reordered or renamed', () => {
    const s = scoreGeneration(
      obs({
        sections: [
          { heading: 'Projects & collaborations', claimCount: 1, gap: false },
          { heading: 'Overview', claimCount: 2, gap: false },
        ],
      }),
    );
    expect(s.structurePreserved).toBe(false);
  });

  it('counts a gapped section as unfilled but still structure-preserving', () => {
    const s = scoreGeneration(
      obs({
        sections: [
          { heading: 'Overview', claimCount: 2, gap: false },
          { heading: 'Projects & collaborations', claimCount: 0, gap: true },
        ],
        regroundVerdicts: [true, true],
      }),
    );
    expect(s.structurePreserved).toBe(true);
    expect(s.sectionsFilled).toBe(1);
    expect(s.groundingPass).toBe(true);
  });

  it('a no_evidence run grounds vacuously and preserves no structure', () => {
    const s = scoreGeneration(
      obs({ status: 'no_evidence', sections: [], regroundVerdicts: [], recordCount: 0 }),
    );
    expect(s.status).toBe('no_evidence');
    expect(s.structurePreserved).toBe(false);
    expect(s.groundingPass).toBe(true);
    expect(s.sectionsFilled).toBe(0);
  });

  it('reports dropped claims without treating them as failures', () => {
    const s = scoreGeneration(obs({ droppedClaims: 4 }));
    expect(s.droppedClaims).toBe(4);
    expect(s.groundingPass).toBe(true);
  });
});

describe('aggregateGenerationScores', () => {
  it('groundingPass is false iff any subject has an ungrounded survivor', () => {
    const ok = scoreGeneration(obs());
    const bad = scoreGeneration(obs({ subject: 'Marta', regroundVerdicts: [false] }));
    expect(aggregateGenerationScores([ok]).groundingPass).toBe(true);
    const agg = aggregateGenerationScores([ok, bad]);
    expect(agg.groundingPass).toBe(false);
    expect(agg.totalUngrounded).toBe(1);
    expect(agg.generated).toBe(2);
    expect(agg.structurePreserved).toBe(2);
  });
});

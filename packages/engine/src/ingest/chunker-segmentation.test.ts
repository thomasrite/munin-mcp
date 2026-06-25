// Sentence-segmenter evaluation (decisions 13).
//
// A hand-labelled gold set of abbreviation-heavy, organisation-flavoured prose. Each
// entry is the list of sentences a human would split the text into. We score
// the current regex `segmentSentences` by boundary-F1 against the gold split.
//
// Decision rule (decisions 13): if boundary-F1 < 0.95 (i.e. >5% of boundaries
// wrong), upgrade to a real segmenter library and re-score. Otherwise keep the
// regex. This test both records the score and acts as a regression guard.

import { describe, expect, it } from 'vitest';

import { segmentSentences } from './chunker';

interface GoldCase {
  readonly name: string;
  readonly text: string;
  readonly sentences: readonly string[];
}

// ~40 sentence-boundaries across realistic constructions: honorific
// abbreviations, place abbreviations, decimals, dates, initials, e.g./i.e.,
// quotations, and ordinary multi-sentence prose.
const GOLD: readonly GoldCase[] = [
  {
    name: 'honorifics-and-places',
    text: "Mrs. Smith, director of St. Mary's, met Dr. Patel on 3 Mar. 2026. They discussed attendance.",
    sentences: [
      "Mrs. Smith, director of St. Mary's, met Dr. Patel on 3 Mar. 2026.",
      'They discussed attendance.',
    ],
  },
  {
    name: 'decimals',
    text: 'The budget rose by 3.5 percent this year. Next year it falls by 1.2 percent.',
    sentences: ['The budget rose by 3.5 percent this year.', 'Next year it falls by 1.2 percent.'],
  },
  {
    name: 'eg-ie',
    text: 'Several subjects improved, e.g. maths and science. Others, i.e. the arts, held steady.',
    sentences: [
      'Several subjects improved, e.g. maths and science.',
      'Others, i.e. the arts, held steady.',
    ],
  },
  {
    name: 'initials',
    text: 'The report was signed by J. R. Hartley. It was filed on Monday.',
    sentences: ['The report was signed by J. R. Hartley.', 'It was filed on Monday.'],
  },
  {
    name: 'question-exclaim',
    text: 'Did the inspection go well? The team thought so! A formal report follows.',
    sentences: ['Did the inspection go well?', 'The team thought so!', 'A formal report follows.'],
  },
  {
    name: 'plain-prose',
    text: 'The office opened in September. Enrolment exceeded expectations. Staff morale was high.',
    sentences: [
      'The office opened in September.',
      'Enrolment exceeded expectations.',
      'Staff morale was high.',
    ],
  },
  {
    name: 'abbrev-mid',
    text: 'See pp. 4 for details. The vol. covers three years.',
    sentences: ['See pp. 4 for details.', 'The vol. covers three years.'],
  },
  {
    name: 'no-split',
    text: "The group comprises St. Mary's, St. John's and St. Peter's regional offices.",
    sentences: ["The group comprises St. Mary's, St. John's and St. Peter's regional offices."],
  },
  {
    // Regression guard: a real sentence ending in a lone capital must STILL
    // split — the initials guard only suppresses runs of initials.
    name: 'lone-capital-grade',
    text: 'She earned a grade A. Then she left.',
    sentences: ['She earned a grade A.', 'Then she left.'],
  },
  {
    name: 'lone-capital-row',
    text: 'Members sat in row B. The lesson began.',
    sentences: ['Members sat in row B.', 'The lesson began.'],
  },
];

// Score boundary detection. We compare the *set of sentence texts* the
// segmenter produced against the gold set per case. A boundary is correct when
// the produced sentence exactly matches a gold sentence (after whitespace
// normalisation). Precision/recall/F1 are aggregated across all cases.
function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function scoreF1(): {
  precision: number;
  recall: number;
  f1: number;
  perCase: { name: string; ok: boolean }[];
} {
  let truePositives = 0;
  let produced = 0;
  let expected = 0;
  const perCase: { name: string; ok: boolean }[] = [];

  for (const g of GOLD) {
    const gold = g.sentences.map(normalise);
    const got = segmentSentences(g.text).map(normalise);
    produced += got.length;
    expected += gold.length;

    const goldRemaining = [...gold];
    let caseTp = 0;
    for (const s of got) {
      const idx = goldRemaining.indexOf(s);
      if (idx >= 0) {
        caseTp += 1;
        goldRemaining.splice(idx, 1);
      }
    }
    truePositives += caseTp;
    perCase.push({ name: g.name, ok: caseTp === gold.length && got.length === gold.length });
  }

  const precision = produced === 0 ? 0 : truePositives / produced;
  const recall = expected === 0 ? 0 : truePositives / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, perCase };
}

describe('sentence segmenter — gold-set evaluation (decisions 13)', () => {
  it('reports boundary-F1 and meets the 0.95 threshold (else upgrade to a library)', () => {
    const { precision, recall, f1, perCase } = scoreF1();
    // Surfaced so the score is visible in test output and recorded in decisions.md.
    console.info(
      `[segmenter] precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} f1=${f1.toFixed(3)}; ` +
        `failing cases: ${
          perCase
            .filter((c) => !c.ok)
            .map((c) => c.name)
            .join(', ') || 'none'
        }`,
    );
    expect(f1).toBeGreaterThanOrEqual(0.95);
  });
});

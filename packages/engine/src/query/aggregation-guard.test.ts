import { describe, expect, it } from 'vitest';

import { COUNT_DECLINE_MESSAGE, isAggregationQuestion } from './aggregation-guard';

describe('isAggregationQuestion', () => {
  it('fires on count / aggregation phrasings', () => {
    const counts = [
      'How many projects are recorded across the organisation?',
      'How many open tasks are there?',
      'how many people have an active assignment of any kind',
      'What is the total number of records?',
      'How much budget is there in total?',
      'Give me the number of items.',
      'count all the entries on file',
    ];
    for (const q of counts) expect(isAggregationQuestion(q)).toBe(true);
  });

  it('does NOT fire on specific retrieval / entity / honesty questions', () => {
    const nonCounts = [
      'What is the status of the Apollo project?',
      'Was the Borealis proposal approved?',
      'Summarise everything on file about Alex Carter.',
      "What was the outcome of Gregory Wainwright's review?",
      'Draft a summary for Bianca Lowe.',
    ];
    for (const q of nonCounts) expect(isAggregationQuestion(q)).toBe(false);
  });

  it('exposes a non-empty honest-decline message', () => {
    expect(COUNT_DECLINE_MESSAGE.length).toBeGreaterThan(0);
    expect(COUNT_DECLINE_MESSAGE.toLowerCase()).toContain("can't reliably count");
  });
});

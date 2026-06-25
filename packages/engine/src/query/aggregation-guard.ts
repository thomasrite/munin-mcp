// Honest-counting guard. The Q&A path retrieves a TOP-K window of paragraphs, so
// it cannot reliably COUNT or TOTAL across a whole corpus (hundreds of records
// never enter the window) — answering "how many … in total" from retrieval yields
// a confidently-wrong number. Until a dedicated structured-count capability exists,
// the Q&A path detects these questions and declines honestly rather than emit a
// number that might be wrong.
//
// Language-generic and vertical-agnostic: it matches count/aggregation PHRASING
// only and names no domain concept.

// 'how many', 'how much', 'number of', 'count of/the/all', 'total number/count',
// 'in total', 'altogether', 'tally', 'aggregate number/count'.
const COUNT_PATTERNS =
  /\b(how many|how much|number of|count (?:of|the|all|how)|total (?:number|count)|in total|altogether|tally|aggregate (?:number|count))\b/i;

export function isAggregationQuestion(question: string): boolean {
  return COUNT_PATTERNS.test(question);
}

export const COUNT_DECLINE_MESSAGE =
  "I can't reliably count or total across all records yet — counting across the full set of records isn't supported, so rather than give a number that might be wrong, I'd suggest narrowing the question to a specific person or case.";

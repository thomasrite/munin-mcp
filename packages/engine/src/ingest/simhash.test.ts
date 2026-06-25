import { describe, expect, it } from 'vitest';

import {
  NEAR_DUP_HAMMING_THRESHOLD,
  areNearDuplicates,
  computeSimhash,
  hammingDistance,
  simhashSimilarity,
} from './simhash';

// A realistic, document-length HR-shaped policy (synthetic). Near-dup detection
// fingerprints the WHOLE document (all chunks joined), so the unit fixtures are
// document-length, not single sentences — at that scale a one-word edit moves
// only a couple of bits, the property detection relies on. (Synthetic-data
// rule: invented text, not real customer content.)
const ORIGINAL = `The organisation is committed to providing a safe and supportive working
environment for all employees and to resolving concerns fairly, consistently and without undue
delay. This procedure sets out how a member of staff may raise a formal grievance and how the
organisation will respond. It applies to all employees regardless of length of service.

Where a member of staff raises a concern under the formal grievance procedure, the matter will be
acknowledged in writing within five working days and a meeting arranged to discuss the issue. The
employee should set out the nature of the grievance in writing, giving as much relevant detail as
possible, including dates, the people involved and any steps already taken to resolve the matter
informally.

Both parties may be accompanied by a colleague or a recognised trade union representative at any
formal meeting held under this procedure. The companion may address the meeting and confer with the
employee but may not answer questions on the employee's behalf. Reasonable notice of the meeting
will be given so that the employee can arrange to be accompanied.

The outcome of the grievance meeting will be confirmed in writing, together with the reasons for the
decision and details of the right to appeal within ten working days. An appeal will, wherever
possible, be heard by a manager who has not previously been involved, and the decision reached at
the appeal stage will be final. Records will be kept confidentially in accordance with data
protection requirements.`;

// One-word substitution ("five" → "seven") — a lightly-edited copy.
const LIGHT_EDIT = ORIGINAL.replace('within five working days', 'within seven working days');

// Same length, completely different subject matter (annual leave, not grievance).
const UNRELATED = `Annual leave accrues at a rate of two and a half days per completed calendar
month of continuous service, up to the contractual maximum set out in the employee's statement of
particulars. The leave year runs from the first of September to the thirty-first of August.

Requests for leave must be submitted through the staff portal at least two weeks in advance and are
subject to approval by the line manager, taking account of operational needs and the leave already
booked by other team members during the requested period. Approval will not be unreasonably
withheld, but the organisation reserves the right to decline a request where business needs require.

Untaken leave may not normally be carried over into the following leave year. In exceptional
circumstances, and with the prior written agreement of the head of department, up to five days may
be carried forward and must then be taken within the first three months of the new leave year.

On termination of employment, payment will be made in lieu of any accrued but untaken statutory
leave, calculated on a pro-rata basis to the last day of service. Where an employee has taken more
leave than accrued, a corresponding deduction may be made from final pay in accordance with the
contract of employment.`;

describe('computeSimhash', () => {
  it('is a 16-char lowercase hex string', () => {
    const fp = computeSimhash(ORIGINAL);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — identical input yields identical output', () => {
    expect(computeSimhash(ORIGINAL)).toBe(computeSimhash(ORIGINAL));
    expect(computeSimhash(UNRELATED)).toBe(computeSimhash(UNRELATED));
  });

  it('identical documents have Hamming distance 0', () => {
    expect(hammingDistance(computeSimhash(ORIGINAL), computeSimhash(ORIGINAL))).toBe(0);
  });

  it('a lightly-edited copy is within the near-dup threshold', () => {
    const d = hammingDistance(computeSimhash(ORIGINAL), computeSimhash(LIGHT_EDIT));
    expect(d).toBeGreaterThan(0); // not byte-identical
    expect(d).toBeLessThanOrEqual(NEAR_DUP_HAMMING_THRESHOLD);
    expect(areNearDuplicates(computeSimhash(ORIGINAL), computeSimhash(LIGHT_EDIT))).toBe(true);
  });

  it('an unrelated document is far above the threshold', () => {
    const d = hammingDistance(computeSimhash(ORIGINAL), computeSimhash(UNRELATED));
    expect(d).toBeGreaterThan(NEAR_DUP_HAMMING_THRESHOLD);
    expect(areNearDuplicates(computeSimhash(ORIGINAL), computeSimhash(UNRELATED))).toBe(false);
  });

  it('empty / token-free text yields the deterministic all-zero fingerprint', () => {
    expect(computeSimhash('')).toBe('0000000000000000');
    expect(computeSimhash('   \n\t  ')).toBe('0000000000000000');
  });
});

describe('hammingDistance', () => {
  it('counts differing bits across the full 64-bit width', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1); // top bit
  });
});

describe('simhashSimilarity', () => {
  it('is 1 for identical and 0 for fully opposite fingerprints', () => {
    expect(simhashSimilarity('abcdef0123456789', 'abcdef0123456789')).toBe(1);
    expect(simhashSimilarity('0000000000000000', 'ffffffffffffffff')).toBe(0);
  });

  it('reflects a near-dup as a high (but sub-1) similarity', () => {
    const sim = simhashSimilarity(computeSimhash(ORIGINAL), computeSimhash(LIGHT_EDIT));
    expect(sim).toBeGreaterThan(0.95);
    expect(sim).toBeLessThan(1);
  });
});

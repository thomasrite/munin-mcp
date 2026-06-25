// Unit tests for the retention TTL config (pure, no DB). The sweep semantics
// are proven on real Postgres in retention-sweep.int.test.ts and on PGlite in
// learning/learning-store.pglite.test.ts.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEEDBACK_RETENTION_DAYS,
  DEFAULT_REVIEW_RETENTION_DAYS,
  feedbackRetentionDays,
  retentionCutoff,
  reviewRetentionDays,
} from './retention-sweep';

describe('feedbackRetentionDays (MUNIN_FEEDBACK_RETENTION_DAYS)', () => {
  it('defaults to 90 days when unset or blank (provisional pending the DPO conversation)', () => {
    expect(feedbackRetentionDays({})).toBe(90);
    expect(feedbackRetentionDays({})).toBe(DEFAULT_FEEDBACK_RETENTION_DAYS);
    expect(feedbackRetentionDays({ MUNIN_FEEDBACK_RETENTION_DAYS: '  ' })).toBe(90);
  });

  it('honours a valid override', () => {
    expect(feedbackRetentionDays({ MUNIN_FEEDBACK_RETENTION_DAYS: '30' })).toBe(30);
    expect(feedbackRetentionDays({ MUNIN_FEEDBACK_RETENTION_DAYS: '365' })).toBe(365);
  });

  it('fails fast on garbage — a garbled TTL must never silently widen retention', () => {
    // Includes exotic-but-numeric spellings ('1e3', '0x10', '+30'): a TTL is
    // plain decimal digits or it is a config error.
    for (const bad of ['ninety', '0', '-5', '1.5', 'NaN', 'Infinity', '1e3', '0x10', '+30']) {
      expect(() => feedbackRetentionDays({ MUNIN_FEEDBACK_RETENTION_DAYS: bad }), bad).toThrowError(
        /MUNIN_FEEDBACK_RETENTION_DAYS must be a positive integer/,
      );
    }
  });
});

describe('reviewRetentionDays (MUNIN_REVIEW_RETENTION_DAYS)', () => {
  it('defaults to 90 days when unset (provisional pending the DPO conversation)', () => {
    expect(reviewRetentionDays({})).toBe(DEFAULT_REVIEW_RETENTION_DAYS);
    expect(reviewRetentionDays({})).toBe(90);
  });

  it('honours a valid override and fails fast on garbage (same parser as feedback)', () => {
    expect(reviewRetentionDays({ MUNIN_REVIEW_RETENTION_DAYS: '30' })).toBe(30);
    expect(() => reviewRetentionDays({ MUNIN_REVIEW_RETENTION_DAYS: 'forever' })).toThrowError(
      /MUNIN_REVIEW_RETENTION_DAYS must be a positive integer/,
    );
  });
});

describe('retentionCutoff', () => {
  it('is exactly now − days', () => {
    const fixed = new Date('2026-06-10T12:00:00.000Z');
    expect(retentionCutoff(90, fixed).toISOString()).toBe('2026-03-12T12:00:00.000Z');
    expect(retentionCutoff(1, fixed).toISOString()).toBe('2026-06-09T12:00:00.000Z');
  });
});

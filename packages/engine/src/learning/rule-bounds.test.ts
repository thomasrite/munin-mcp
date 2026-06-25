// Unit tests for the deterministic rule-text bounds (G2a/P2-1) — pure, no DB.
//
// The bounds run BEFORE any database access in insertRule/writeSharedRule, so a
// dummy db handle proves the rejects without a container (it also ENFORCES the
// pre-DB ordering: a reordered check would crash on the hollow handle). The
// ACCEPT paths (at-the-caps rules stored fine) are proven against real
// Postgres in learning-store.int.test.ts; learning-store.pglite.test.ts's
// existing valid-rule inserts stay green on PGlite.

import { describe, expect, it } from 'vitest';

import { asActorId, asTenantId } from '../graph/types';

import { LearningRuleBoundsError } from './errors';
import { LearningStore, RULE_TEXT_MAX_CHARS, RULE_TEXT_MAX_LINES } from './learning-store';
import type { LearningContext } from './types';

// Bounds checks throw before this.db is touched — a hollow handle suffices.
const store = new LearningStore({} as never);
const ctx: LearningContext = { tenantId: asTenantId(crypto.randomUUID()), actor: asActorId('a') };

const vec1024 = Array.from({ length: 1024 }, () => 0.1);
const baseInsert = {
  sourceFeedbackId: crypto.randomUUID(),
  scope: 'personal' as const,
  ruleKey: 'tone',
  embedding: vec1024,
  confidence: 0.5,
};

const CASES: ReadonlyArray<{ name: string; ruleText: string; reason: RegExp }> = [
  { name: 'empty', ruleText: '', reason: /must not be empty/ },
  { name: 'whitespace-only', ruleText: '  \n ', reason: /must not be empty/ },
  {
    name: `over the ${RULE_TEXT_MAX_CHARS}-char cap`,
    ruleText: 'x'.repeat(RULE_TEXT_MAX_CHARS + 1),
    reason: /chars; the cap is/,
  },
  {
    name: `over the ${RULE_TEXT_MAX_LINES}-line cap`,
    ruleText: 'a\nb\nc\nd',
    reason: /lines; the cap is/,
  },
  {
    name: 'over the line cap via bare-CR line breaks',
    ruleText: 'a\rb\rc\rd',
    reason: /lines; the cap is/,
  },
];

describe('rule-text bounds — insertRule (personal path)', () => {
  for (const c of CASES) {
    it(`rejects ${c.name} with a typed error, before any DB access`, async () => {
      await expect(store.insertRule(ctx, { ...baseInsert, ruleText: c.ruleText })).rejects.toThrow(
        LearningRuleBoundsError,
      );
      await expect(store.insertRule(ctx, { ...baseInsert, ruleText: c.ruleText })).rejects.toThrow(
        c.reason,
      );
    });
  }
});

describe('rule-text bounds — writeSharedRule (gated promotion path)', () => {
  for (const c of CASES) {
    it(`rejects ${c.name} with a typed error, before any DB access`, async () => {
      const input = { ...baseInsert, ruleText: c.ruleText };
      await expect(store.writeSharedRule(ctx, input)).rejects.toThrow(LearningRuleBoundsError);
      await expect(store.writeSharedRule(ctx, input)).rejects.toThrow(c.reason);
    });
  }
});

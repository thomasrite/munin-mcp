// classifyQuestion (G1 / F31) — unit. Pure; routes on entity-PRESENCE, fails safe.

import type { EntityResolutionHints } from '@muninhq/shared';
import { describe, expect, it } from 'vitest';

import { classifyQuestion } from './classify-question';
import type { ResolvableEntity } from './resolution';

// Generic config identity hook for an opaque "Employee" subject type (no vertical
// term — the type name is arbitrary fixture data, exactly as config supplies it).
const HINTS = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['ref'] }],
]);

function emp(id: string, fullName: string, ref?: string): ResolvableEntity {
  return {
    id,
    type: 'Employee',
    properties: { fullName, ...(ref ? { ref } : {}) },
    contextVector: null,
  };
}

describe('classifyQuestion — routes on entity-presence, not phrasing', () => {
  it('a question naming no visible subject is OPEN (vector path)', () => {
    const entities = [emp('e1', 'Helena Voss', 'R1'), emp('e2', 'Adrian Cole', 'R2')];
    const c = classifyQuestion({
      question: 'What does our absence policy say about long-term sickness?',
      entities,
      hintsByType: HINTS,
    });
    expect(c.kind).toBe('open');
  });

  it('a question naming a visible subject is ENTITY-CENTRIC (no wording trigger needed)', () => {
    const entities = [emp('e1', 'Helena Voss', 'R1'), emp('e2', 'Adrian Cole', 'R2')];
    // No "everything about" phrasing — just the name. Presence, not phrasing.
    const c = classifyQuestion({ question: 'Helena Voss absence', entities, hintsByType: HINTS });
    expect(c.kind).toBe('entity-centric');
    if (c.kind !== 'entity-centric') return;
    expect(c.entityType).toBe('Employee');
    expect(c.subjectKey.toLowerCase()).toContain('voss');
    expect(c.clusters.length).toBe(1);
  });

  it('matches initial name-forms via the resolver tokenisation (H. Voss / Helena Voss)', () => {
    const entities = [emp('e1', 'Helena Voss', 'R1')];
    for (const q of ['What happened with Helena Voss?', 'summarise H. Voss']) {
      const c = classifyQuestion({ question: q, entities, hintsByType: HINTS });
      expect(c.kind).toBe('entity-centric');
    }
  });

  it('a bare surname-only mention ("Ms Voss", no given name) stays OPEN — safe (no completeness claimed)', () => {
    // We cannot distinguish a genuine surname-only person reference from a
    // surname-shaped common word with no given-name signal. The fail-safe choice
    // is the OPEN vector path: it asserts NO per-person completeness, so it cannot
    // produce an incomplete-and-unbanned answer. (A given-name form routes to gather.)
    const entities = [emp('e1', 'Helena Voss', 'R1')];
    const c = classifyQuestion({
      question: 'What happened with Ms Voss?',
      entities,
      hintsByType: HINTS,
    });
    expect(c.kind).toBe('open');
  });

  // The same-name decoy F31 exposes: a single "Mark Davies" name query must offer
  // BOTH same-name people as candidates (the web layer disambiguates), never
  // silently pick one. classifyQuestion returns both clusters under one identity.
  it('SAME-NAME decoy: names both Mark Davies clusters as one identity to disambiguate', () => {
    const entities = [
      emp('a1', 'Mark Davies', 'KEY-A'), // subject
      emp('a2', 'Mark Davies', 'KEY-A'),
      emp('b1', 'Mark Davies', 'KEY-B'), // a different person, same name
      emp('b2', 'Mark Davies', 'KEY-B'),
      emp('z1', 'Helena Voss', 'R1'),
    ];
    const c = classifyQuestion({
      question: 'What is on file about Mark Davies?',
      entities,
      hintsByType: HINTS,
    });
    expect(c.kind).toBe('entity-centric');
    if (c.kind !== 'entity-centric') return;
    expect(c.entityType).toBe('Employee');
    // Two distinct logical clusters share the name → both offered (≥2 candidates).
    expect(c.clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('FAIL SAFE: an empty visible set is OPEN (nothing to gather)', () => {
    const c = classifyQuestion({ question: 'Helena Voss', entities: [], hintsByType: HINTS });
    expect(c.kind).toBe('open');
  });

  it('FAIL SAFE: a bare unrelated surname in prose does NOT trigger the identity path', () => {
    // "Cole" appears, but the question is about a policy, not the person Adrian
    // Cole — requiring ALL name tokens (given + surname) keeps this OPEN, which is
    // the SAFE vector path (no per-person completeness is implied or asserted).
    const entities = [emp('e1', 'Adrian Cole', 'R2')];
    const c = classifyQuestion({
      question: 'What is the policy on cole storage in the boiler room?',
      entities,
      hintsByType: HINTS,
    });
    expect(c.kind).toBe('open');
  });
});

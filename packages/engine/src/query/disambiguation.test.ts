import { describe, expect, it } from 'vitest';

import type { EntityResolutionHints } from '@muninhq/shared';
import {
  buildDisambiguation,
  gatherTargetForCandidate,
  gatherTargetForCluster,
  selectCandidate,
} from './disambiguation';
import { type ResolvableEntity, compatibleNames, nameTokens, resolveEntities } from './resolution';

const HINTS = new Map<string, EntityResolutionHints>([
  [
    'Employee',
    {
      identityProperties: ['fullName'],
      distinguishingProperties: ['department'],
      exactKeyProperties: ['employeeRef'],
    },
  ],
]);

// Two distinct "Sarah Jones" (different departments, no shared key) + name-form
// variants of each. The resolver splits them (never-false-merge) and flags
// ambiguous; disambiguation packages them as two candidates.
function twoSarahs(): ResolvableEntity[] {
  return [
    {
      id: 'a1',
      type: 'Employee',
      properties: { fullName: 'Sarah Jones', department: 'Northgate', employeeRef: 'EMP-1' },
      contextVector: [1, 0, 0],
    },
    {
      id: 'a2',
      type: 'Employee',
      properties: { fullName: 'Ms Jones', department: 'Northgate', employeeRef: 'EMP-1' },
      contextVector: [1, 0, 0],
    },
    {
      id: 'b1',
      type: 'Employee',
      properties: { fullName: 'Sarah Jones', department: 'Westfield', employeeRef: 'EMP-2' },
      contextVector: [0, 1, 0],
    },
    {
      id: 'b2',
      type: 'Employee',
      properties: { fullName: 'S. Jones', department: 'Westfield', employeeRef: 'EMP-2' },
      contextVector: [0, 1, 0],
    },
  ];
}

describe('buildDisambiguation (present)', () => {
  it('packages a same-name collision into one group with >= 2 candidates carrying distinguishing info', () => {
    const entities = twoSarahs();
    const resolution = resolveEntities(entities, HINTS);
    const dis = buildDisambiguation(resolution, entities, HINTS);

    expect(dis.groups).toHaveLength(1);
    const group = dis.groups[0]!;
    expect(group.candidates.length).toBeGreaterThanOrEqual(2);

    // Each candidate exposes the distinguishing property (department) over its members.
    const departments = group.candidates.flatMap((c) => c.distinguishing.department ?? []);
    expect(departments).toEqual(expect.arrayContaining(['Northgate', 'Westfield']));
    // Counts are visible-scoped (member counts), tokens are present + stable.
    for (const c of group.candidates) {
      expect(c.visibleRecordCount).toBe(c.memberIds.length);
      expect(c.token).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('annotates resolverUncertain: false when a distinguishing property confidently separates the people', () => {
    const entities = twoSarahs(); // different `department` → resolver is CONFIDENT they differ
    const dis = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    expect(dis.groups[0]!.resolverUncertain).toBe(false);
    // …but the group still fires (two real people share the name → user must pick).
    expect(dis.groups[0]!.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('annotates resolverUncertain: true when no signal separates two same-name people', () => {
    // No department, no shared key, divergent context → resolver cannot confirm →
    // splits AND flags ambiguous (never-false-merge). Disambiguation still fires.
    const entities: ResolvableEntity[] = [
      {
        id: 'a',
        type: 'Employee',
        properties: { fullName: 'Sarah Jones' },
        contextVector: [1, 0, 0],
      },
      {
        id: 'b',
        type: 'Employee',
        properties: { fullName: 'Sarah Jones' },
        contextVector: [0, 1, 0],
      },
    ];
    const dis = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    expect(dis.groups).toHaveLength(1);
    expect(dis.groups[0]!.resolverUncertain).toBe(true);
  });

  it('is empty when resolution is unambiguous (single clean entity)', () => {
    const entities: ResolvableEntity[] = [
      {
        id: 'h1',
        type: 'Employee',
        properties: { fullName: 'Helena Voss', employeeRef: 'EMP-9' },
        contextVector: [1, 0, 0],
      },
      {
        id: 'h2',
        type: 'Employee',
        properties: { fullName: 'Ms Voss', employeeRef: 'EMP-9' },
        contextVector: [1, 0, 0],
      },
    ];
    const dis = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    expect(dis.groups).toHaveLength(0);
  });

  it('is deterministic (stable token + ordering across runs)', () => {
    const entities = twoSarahs();
    const a = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    const b = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('selectCandidate (pick) + gatherTargetForCandidate (bind)', () => {
  it('a valid token selects its candidate and binds a key-led gather target', () => {
    const entities = twoSarahs();
    const byId = new Map(entities.map((e) => [e.id, e]));
    const dis = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    const pick = dis.groups[0]!.candidates[0]!;

    const chosen = selectCandidate(dis, pick.token);
    expect(chosen).not.toBeNull();
    expect(chosen!.token).toBe(pick.token);

    const target = gatherTargetForCandidate(chosen!, byId, HINTS);
    expect(target.entityType).toBe('Employee');
    expect(target.keyProperty).toBe('employeeRef');
    // The key value is one of the two refs (whichever person was picked) — and
    // the cluster members are exactly that candidate's members (NOT the other's).
    expect(['EMP-1', 'EMP-2']).toContain(target.keyValue);
    expect([...target.clusterMemberIds].sort()).toEqual([...chosen!.memberIds].sort());
  });

  it('an unknown / stale token returns null (candidate no longer available)', () => {
    const entities = twoSarahs();
    const dis = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    expect(selectCandidate(dis, 'deadbeefdeadbeef')).toBeNull();
  });

  it('the pick selects ONE person, not a merge of both (never-false-merge preserved)', () => {
    const entities = twoSarahs();
    const dis = buildDisambiguation(resolveEntities(entities, HINTS), entities, HINTS);
    const candidates = dis.groups[0]!.candidates;
    // The two candidates are disjoint clusters — a pick never spans both.
    const a = new Set(candidates[0]!.memberIds);
    const b = new Set(candidates[1]!.memberIds);
    for (const id of a) expect(b.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Typo-tolerant entity lookup — DISPOSITION.
// Tom's misspelled-name case ("John Witby" → "John Whitby") is NOT covered by
// M1's resolution: name-form matching is surname-EXACT (it handles initials /
// titles, not edit-distance typos). This test PINS that boundary so the gap is
// explicit and regression-tracked, not silently assumed-covered. Lifting it is
// M3 anchoring (fuzzy-match a typo'd query against the authoritative staff
// directory).
// ---------------------------------------------------------------------------
describe('typo tolerance — known boundary (deferred to M3)', () => {
  it('a misspelled surname does NOT name-match (documents the M1 limitation)', () => {
    expect(compatibleNames(nameTokens('John Witby'), nameTokens('John Whitby'))).toBe(false);
  });
});

// The gather's key-led path must not re-introduce a wrong key the resolver rejected:
// gatherTargetForCluster must not bind a ref-shaped value as the gather key (else a
// key-led gather would re-pull a different person's records — the silent merge at the
// gather level).
describe('gatherTargetForCluster — rejects a ref-shaped key value (no key-led re-merge)', () => {
  const HINTS_KEY_PATTERN = new Map<string, EntityResolutionHints>([
    [
      'Employee',
      {
        identityProperties: ['fullName'],
        exactKeyProperties: ['employeeRef'],
        exactKeyPatterns: { employeeRef: '^[A-Za-z0-9]+(-[A-Za-z0-9]+)?$' },
      },
    ],
  ]);
  const ent = (id: string, employeeRef: string): ResolvableEntity => ({
    id,
    type: 'Employee',
    properties: { fullName: 'Helena Reyes', employeeRef },
    contextVector: null,
  });

  it('omits a ref-shaped key value (RED before fix) → cluster-only gather', () => {
    const byId = new Map([['a', ent('a', 'INV-2026-014')]]);
    const target = gatherTargetForCluster('Employee', ['a'], byId, HINTS_KEY_PATTERN);
    expect(target.keyValue).toBeUndefined(); // not used as a key
    expect(target.keyProperty).toBeUndefined();
  });

  it('still binds a VALID key value (no regression)', () => {
    const byId = new Map([['a', ent('a', 'EMP-001')]]);
    const target = gatherTargetForCluster('Employee', ['a'], byId, HINTS_KEY_PATTERN);
    expect(target.keyValue).toBe('EMP-001');
    expect(target.keyProperty).toBe('employeeRef');
  });
});

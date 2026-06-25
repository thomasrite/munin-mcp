// resolveSubjectToGatherTarget — unit. This is the SINGLE resolution decision
// both the entity-centric retriever (Q&A) and the web generate action route
// through, so its branches are pinned here: target / disambiguation (present) /
// pick / stale-pick / ambiguous (distinct-name loose match) / not-found. The two
// callers used to re-implement this with subtle divergence (the "be more
// specific" branch) — these tests lock the one implementation.

import type { EntityResolutionHints } from '@muninhq/shared';
import { describe, expect, it } from 'vitest';

import { type ResolvableEntity, resolveEntities } from './resolution';
import { resolveSubjectToGatherTarget } from './resolve-target';

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

const emp = (
  id: string,
  fullName: string,
  employeeRef: string,
  department?: string,
): ResolvableEntity => ({
  id,
  type: 'Employee',
  properties: { fullName, employeeRef, ...(department ? { department } : {}) },
  contextVector: null,
});

// Two distinct people who share the name "Sarah Jones" (different departments + keys
// → the resolver keeps them separate → a same-name collision group).
function twoSarahs(): ResolvableEntity[] {
  return [
    emp('a1', 'Sarah Jones', 'EMP-1', 'Northgate'),
    emp('b1', 'Sarah Jones', 'EMP-2', 'Westfield'),
  ];
}

function resolve(resolvable: ResolvableEntity[], subjectKey: string, pick?: string) {
  return resolveSubjectToGatherTarget({
    resolvable,
    subjectKey,
    entityType: 'Employee',
    hintsByType: HINTS,
    ...(pick ? { pick } : {}),
  });
}

describe('resolveSubjectToGatherTarget — the single subject→target decision', () => {
  it('a single named subject → a gather target bound to that subject', () => {
    const res = resolve([emp('h1', 'Helena Voss', 'EMP-9')], 'Helena Voss');
    expect(res.kind).toBe('target');
    if (res.kind !== 'target') return;
    expect(res.subject.toLowerCase()).toContain('voss');
    expect(res.target.entityType).toBe('Employee');
    // Key-led gather (the exact key was present on the member).
    expect(res.target.keyValue).toBe('EMP-9');
  });

  it('a same-name collision → disambiguation (present), never a silent pick', () => {
    const res = resolve(twoSarahs(), 'Sarah Jones');
    expect(res.kind).toBe('disambiguation');
    if (res.kind !== 'disambiguation') return;
    expect(res.pickWasStale).toBe(false);
    expect(res.group.candidates.length).toBe(2);
    expect(res.entitiesById.size).toBe(2);
  });

  it('a valid pick token → the chosen candidate as a gather target', () => {
    const presented = resolve(twoSarahs(), 'Sarah Jones');
    expect(presented.kind).toBe('disambiguation');
    if (presented.kind !== 'disambiguation') return;
    const token = presented.group.candidates[0]?.token;
    expect(token).toBeDefined();
    if (!token) return;

    const picked = resolve(twoSarahs(), 'Sarah Jones', token);
    expect(picked.kind).toBe('target');
    if (picked.kind !== 'target') return;
    expect(picked.subject.toLowerCase()).toContain('jones');
    // The pick selected ONE of the two distinct keys (never a merge of both).
    expect(['EMP-1', 'EMP-2']).toContain(picked.target.keyValue);
  });

  it('a stale pick token, but the group is still present → re-present (pickWasStale)', () => {
    const res = resolve(twoSarahs(), 'Sarah Jones', 'no-such-token');
    expect(res.kind).toBe('disambiguation');
    if (res.kind !== 'disambiguation') return;
    expect(res.pickWasStale).toBe(true);
  });

  it('a stale pick token with no matching group → not-found (cannot resolve)', () => {
    const res = resolve([emp('h1', 'Helena Voss', 'EMP-9')], 'Helena Voss', 'no-such-token');
    expect(res.kind).toBe('not-found');
  });

  it('a loose query matching several DISTINCT names → ambiguous (caller decides)', () => {
    // "jones" matches two clusters with DIFFERENT given names (not a same-name
    // collision, so no disambiguation group): the resolver cannot pick for us.
    const res = resolve(
      [emp('s1', 'Sarah Jones', 'EMP-1'), emp('m1', 'Mary Jones', 'EMP-2')],
      'jones',
    );
    expect(res.kind).toBe('ambiguous');
    if (res.kind !== 'ambiguous') return;
    expect(res.matches.length).toBe(2);
    expect(res.matches.map((m) => m.toLowerCase()).sort()).toEqual(['mary jones', 'sarah jones']);
  });

  it('no visible cluster matches the named subject → not-found', () => {
    const res = resolve([emp('h1', 'Helena Voss', 'EMP-9')], 'Nobody Atall');
    expect(res.kind).toBe('not-found');
  });

  // The false-same-name-collision fix (the scale lever). A keyless variant
  // ("H. Voss") with no employeeRef in its source doc, stranded because an
  // unrelated same-surname person (Marcus Voss) made the surname block
  // multi-identity. A query for the UNIQUE full name "Helena Voss" must resolve
  // cleanly and gather the variant too — not disambiguate Helena against herself.
  const variant = (id: string, fullName: string, department?: string): ResolvableEntity => ({
    id,
    type: 'Employee',
    properties: { fullName, ...(department ? { department } : {}) }, // keyless (no employeeRef)
    contextVector: null,
  });

  it('a unique full name resolves cleanly despite a stranded own-variant (no false collision)', () => {
    const set = [
      emp('h1', 'Helena Voss', 'EMP-9'),
      variant('h2', 'H. Voss'), // Helena's keyless variant mention
      emp('m1', 'Marcus Voss', 'EMP-7'), // unrelated → makes the Voss block multi-identity
    ];
    // Sanity: M1.1 strands the variant as a separate ambiguous cluster.
    expect(resolveEntities(set, HINTS).clusters.length).toBeGreaterThanOrEqual(2);

    const res = resolve(set, 'Helena Voss');
    expect(res.kind).toBe('target');
    if (res.kind !== 'target') return;
    expect(res.subject.toLowerCase()).toContain('helena voss');
    // Key-led on Helena's ref, AND the keyless variant is absorbed into the gather.
    expect(res.target.keyValue).toBe('EMP-9');
    expect([...res.target.clusterMemberIds].sort()).toEqual(['h1', 'h2']);
    // Marcus is a different person and is never gathered.
    expect(res.target.clusterMemberIds).not.toContain('m1');
  });

  it('a person fragmented across keyed + keyless same-name clusters resolves to one (the 22/28 case)', () => {
    // At scale the exact key is SPARSE: only some mentions carry the employeeRef,
    // so one person's well-specified "Helena Voss" mentions land in several
    // clusters (one keyed, the rest keyless) that buildDisambiguation groups. No
    // disambiguating attribute conflicts → it is ONE person, not a collision.
    const set = [
      emp('h1', 'Helena Voss', 'EMP-9'), // keyed mention
      variant('h2', 'Helena Voss'), // keyless mention of the same person
      variant('h3', 'Helena Voss'), // another keyless mention
      emp('m1', 'Marcus Voss', 'EMP-7'), // makes the surname block multi-identity
    ];
    const res = resolve(set, 'Helena Voss');
    expect(res.kind).toBe('target');
    if (res.kind !== 'target') return;
    expect(res.target.keyValue).toBe('EMP-9'); // gathers by Helena's key…
    expect([...res.target.clusterMemberIds].sort()).toEqual(['h1', 'h2', 'h3']); // …+ all her mentions
    expect(res.target.clusterMemberIds).not.toContain('m1');
  });

  it('two genuinely-distinct same-name people still disambiguate (never auto-resolved)', () => {
    // Two real "Helena Voss" (conflicting keys + departments) plus a stranding Marcus.
    const set = [
      emp('h1', 'Helena Voss', 'EMP-9', 'Northgate'),
      emp('h2', 'Helena Voss', 'EMP-8', 'Westfield'),
      emp('m1', 'Marcus Voss', 'EMP-7'),
    ];
    const res = resolve(set, 'Helena Voss');
    expect(res.kind).toBe('disambiguation');
  });

  it('a PARTIAL/first-name query resolves to the one person it names (the dominant scale case)', () => {
    // Questions at scale name people partially ("Karen", "Grace", "Mr Voss").
    // "Karen" names one person fragmented across keyed + keyless mentions; a
    // different-given-name Nguyen makes the block multi-identity (stranding them).
    const set = [
      emp('k1', 'Karen Nguyen', 'EMP-1'), // keyed mention
      variant('k2', 'Karen Nguyen'), // keyless mention of the same person
      emp('o1', 'Tom Nguyen', 'EMP-2'), // unrelated Nguyen → block multi-identity
    ];
    const res = resolve(set, 'Karen'); // first name only
    expect(res.kind).toBe('target');
    if (res.kind !== 'target') return;
    expect(res.target.keyValue).toBe('EMP-1');
    expect([...res.target.clusterMemberIds].sort()).toEqual(['k1', 'k2']);
    expect(res.target.clusterMemberIds).not.toContain('o1'); // Tom is never gathered
  });

  it('same-name clusters with NO exact key are not collapsed — disambiguate (no positive anchor)', () => {
    // Two keyless "Jordan Reed" could be one fragmented person OR two people who
    // share a name; with no key to anchor identity, the safe answer is to ask —
    // never silently merge two potentially-distinct employees.
    const set = [
      variant('j1', 'Jordan Reed'), // keyless
      variant('j2', 'Jordan Reed'), // keyless
      emp('o1', 'Sam Reed', 'EMP-2'), // makes the Reed block multi-identity
    ];
    const res = resolve(set, 'Jordan Reed');
    expect(res.kind).toBe('disambiguation');
  });

  it('a partial query naming TWO distinct keyed people still disambiguates', () => {
    // Two different people each recorded only as "Sarah" (conflicting keys +
    // departments) → genuinely ambiguous → ask.
    const set = [
      emp('s1', 'Sarah', 'EMP-10', 'Northgate'),
      emp('s2', 'Sarah', 'EMP-20', 'Ashfield'),
    ];
    const res = resolve(set, 'Sarah');
    expect(res.kind).toBe('disambiguation');
  });

  it('an under-specified variant shared by TWO same-surname people is not absorbed', () => {
    // "Ms Voss" (surname only) is compatible with both Helena and Marcus, so a
    // query for "Helena Voss" must NOT pull it in (it could be Marcus's record).
    const set = [
      emp('h1', 'Helena Voss', 'EMP-9'),
      emp('mk', 'Marcus Voss', 'EMP-7'),
      variant('amb', 'Ms Voss'), // bridges both → ambiguous home
    ];
    const res = resolve(set, 'Helena Voss');
    expect(res.kind).toBe('target');
    if (res.kind !== 'target') return;
    expect(res.target.keyValue).toBe('EMP-9');
    expect([...res.target.clusterMemberIds]).toEqual(['h1']); // 'amb' left out, 'mk' left out
  });

  it('a variant with a conflicting distinguishing attribute is not absorbed', () => {
    // "H. Voss" at a DIFFERENT department than Helena → positive evidence of a
    // different person → keep it out of the gather, even with no competing
    // well-specified Voss in the group.
    const set = [
      emp('h1', 'Helena Voss', 'EMP-9', 'Northgate'),
      emp('m1', 'Marcus Voss', 'EMP-7'), // strands the variant
      variant('h2', 'H. Voss', 'Westfield'),
    ];
    const res = resolve(set, 'Helena Voss');
    expect(res.kind).toBe('target');
    if (res.kind !== 'target') return;
    expect([...res.target.clusterMemberIds]).toEqual(['h1']); // 'h2' (Westfield) excluded
  });

  it('is a PURE function of the visible set — no hidden state between calls', () => {
    const set = [emp('h1', 'Helena Voss', 'EMP-9')];
    const a = resolveEntities(set, HINTS); // sanity: the set resolves to one cluster
    expect(a.clusters.length).toBe(1);
    expect(resolve(set, 'Helena Voss')).toEqual(resolve(set, 'Helena Voss'));
  });
});

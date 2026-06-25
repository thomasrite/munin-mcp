import type { EntityResolutionHints } from '@muninhq/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type ResolvableEntity, resolveEntities, validExactKey } from './resolution';

const HINTS = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'] }],
]);

// Helpers: orthogonal-ish vectors for "divergent context", near-identical for "same context".
const near = [1, 0, 0];
const near2 = [0.98, 0.05, 0]; // close to `near`
const far = [0, 1, 0]; // orthogonal to `near` → cosine distance ~1

function emp(
  id: string,
  fullName: string,
  contextVector: readonly number[] | null,
  extra: Record<string, unknown> = {},
): ResolvableEntity {
  return { id, type: 'Employee', properties: { fullName, ...extra }, contextVector };
}

function clusterOf(
  result: { clusters: readonly { memberIds: readonly string[] }[] },
  id: string,
): readonly string[] {
  return result.clusters.find((c) => c.memberIds.includes(id))!.memberIds;
}

describe('resolveEntities — variant coherence (confirm-to-merge)', () => {
  it('merges name-form variants of one person when context confirms', () => {
    const r = resolveEntities(
      [emp('1', 'Helena Voss', near), emp('2', 'Ms Voss', near2), emp('3', 'H. Voss', near)],
      HINTS,
    );
    expect(r.clusters).toHaveLength(1);
    expect(clusterOf(r, '1')).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  it('does NOT merge variants when context diverges (favours split; informative, not a failure)', () => {
    const r = resolveEntities([emp('1', 'Helena Voss', near), emp('2', 'H. Voss', far)], HINTS);
    expect(r.clusters).toHaveLength(2);
  });
});

describe('resolveEntities — NEVER false-merge (the hard bar)', () => {
  it('keeps two distinct same-name people apart when context diverges (clean decoy)', () => {
    const r = resolveEntities([emp('a', 'Sarah Jones', near), emp('b', 'Sarah Jones', far)], HINTS);
    expect(r.clusters).toHaveLength(2);
    expect(clusterOf(r, 'a')).not.toContain('b');
  });

  it('does NOT merge same-name people when context is weak/missing (the noisy hard-decoy case)', () => {
    // Missing context vector → cannot confirm → must not merge.
    const r = resolveEntities(
      [emp('a', 'Sarah Jones', null), emp('b', 'Sarah Jones', null)],
      HINTS,
    );
    expect(r.clusters).toHaveLength(2);
  });

  it('HARDENING: refuses to merge IDENTICAL full names even when context is close (no signal)', () => {
    // The catastrophic case: two distinct people share the exact name and happen
    // to have near-identical context. With no key/distinguishing signal the merge
    // is refused (safe false-split), never risked.
    const r = resolveEntities(
      [emp('a', 'Sarah Jones', near), emp('b', 'Sarah Jones', near2)],
      HINTS,
    );
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters.every((c) => c.ambiguous)).toBe(true);
  });

  it('HARDENING: refuses an under-specified form (initial) in a FORKED block, even with close context', () => {
    // "J. Smith" could be Jane or John → never auto-merge it into either.
    const r = resolveEntities(
      [
        emp('jane', 'Jane Smith', near),
        emp('john', 'John Smith', far),
        emp('amb', 'J. Smith', near2),
      ],
      HINTS,
    );
    // jane and john never cluster (incompatible given names); the ambiguous
    // "J. Smith" is not merged into jane despite close context.
    expect(clusterOf(r, 'jane')).not.toContain('john');
    expect(clusterOf(r, 'jane')).not.toContain('amb');
  });

  it('an identical name CAN still merge when an exact key positively confirms it', () => {
    const hints = new Map([
      ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['payrollId'] }],
    ]);
    const r = resolveEntities(
      [
        emp('a', 'Sarah Jones', far, { payrollId: 'P1' }),
        emp('b', 'Sarah Jones', far, { payrollId: 'P1' }),
      ],
      hints,
    );
    expect(r.clusters).toHaveLength(1);
  });

  it('flags ambiguity when a name is shared across clusters (the M1.3 disambiguation hook)', () => {
    const r = resolveEntities([emp('a', 'Sarah Jones', near), emp('b', 'Sarah Jones', far)], HINTS);
    expect(r.clusters.every((c) => c.ambiguous)).toBe(true);
  });
});

describe('resolveEntities — config hints', () => {
  it('exact natural-key match confirms a merge regardless of context', () => {
    const hints = new Map<string, EntityResolutionHints>([
      ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['payrollId'] }],
    ]);
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', far, { payrollId: 'P99' }),
        emp('2', 'H. Voss', near, { payrollId: 'P99' }),
      ],
      hints,
    );
    expect(r.clusters).toHaveLength(1);
  });

  it('distinguishing-property difference BLOCKS a merge even with confirming context', () => {
    const hints = new Map<string, EntityResolutionHints>([
      ['Employee', { identityProperties: ['fullName'], distinguishingProperties: ['department'] }],
    ]);
    const r = resolveEntities(
      [
        emp('1', 'Sarah Jones', near, { department: 'north' }),
        emp('2', 'Sarah Jones', near, { department: 'south' }),
      ],
      hints,
    );
    expect(r.clusters).toHaveLength(2);
  });

  it('no identity hint for a type → no resolution (every row its own cluster)', () => {
    const r = resolveEntities(
      [emp('1', 'Helena Voss', near), emp('2', 'Helena Voss', near)],
      new Map(),
    );
    expect(r.clusters).toHaveLength(2);
  });
});

describe('resolveEntities — purity', () => {
  it('different surnames never cluster', () => {
    const r = resolveEntities(
      [emp('1', 'Helena Voss', near), emp('2', 'Helena Cole', near)],
      HINTS,
    );
    expect(r.clusters).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F9 — fragmentation resolution: cluster name-form VARIANTS of one person even
// with NO context (the production reality — contextVector is null), so gather
// reaches their scattered records. Guarantee-first: a key conflict is an
// absolute never-merge.
// ---------------------------------------------------------------------------
const HINTS_KEYED = new Map<string, EntityResolutionHints>([
  ['Employee', { identityProperties: ['fullName'], exactKeyProperties: ['employeeRef'] }],
]);

describe('resolveEntities — F9 fragmentation resolution (recall)', () => {
  it('merges reduced name-form variants with NO context in a single-identity block', () => {
    // The production case: one Helena Voss, fragmented across "Helena Voss" /
    // "H. Voss" / "Ms Voss", none carrying a context vector. Pre-F9 these split
    // (3 clusters → gather misses records); F9 clusters them.
    const r = resolveEntities(
      [emp('1', 'Helena Voss', null), emp('2', 'H. Voss', null), emp('3', 'Ms Voss', null)],
      HINTS,
    );
    expect(r.clusters).toHaveLength(1);
    expect(clusterOf(r, '1')).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  it('attaches keyless reduced variants to the single keyed identity', () => {
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 'EMP-001' }),
        emp('2', 'H. Voss', null, { employeeRef: 'EMP-001' }),
        emp('3', 'Ms Voss', null), // keyless grievance mention
        emp('4', 'H. Voss', null), // keyless
      ],
      HINTS_KEYED,
    );
    expect(r.clusters).toHaveLength(1);
    expect(clusterOf(r, '1')).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
  });
});

describe('resolveEntities — F9 NEVER-FALSE-MERGE catastrophe guard (non-negotiable)', () => {
  it('same name, DIFFERENT key → NEVER merged (the data-breach case)', () => {
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 'EMP-001' }),
        emp('2', 'Helena Voss', null, { employeeRef: 'EMP-002' }),
      ],
      HINTS_KEYED,
    );
    expect(r.clusters).toHaveLength(2);
    expect(clusterOf(r, '1')).not.toContain('2');
  });

  it('a key conflict blocks a merge even for a NON-risky variant pair (where recall alone would merge)', () => {
    // "Helena Voss" and "Helena M Voss" are a non-risky variant pair (both well-
    // specified, compatible, not identical) — the F9 no-context rule WOULD merge
    // them. The conflicting employeeRef is hard proof they are different people,
    // so the merge is refused. This is the case ONLY the key guard catches.
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 'EMP-001' }),
        emp('2', 'Helena M Voss', null, { employeeRef: 'EMP-002' }),
      ],
      HINTS_KEYED,
    );
    expect(r.clusters).toHaveLength(2);
    expect(clusterOf(r, '1')).not.toContain('2');
  });

  it('a key conflict blocks even when context is near-identical', () => {
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', near, { employeeRef: 'EMP-001' }),
        emp('2', 'H. Voss', near2, { employeeRef: 'EMP-002' }),
      ],
      HINTS_KEYED,
    );
    expect(r.clusters).toHaveLength(2);
  });

  it('a WELL-SPECIFIED keyless variant cannot TRANSITIVELY bridge two conflicting keys', () => {
    // The subtle catastrophe: "Helena Marie Voss" (keyless, well-specified, an
    // EXTRA spelled-out middle word — not an initial) is name-compatible with BOTH
    // "Helena Voss"(EMP-001) and "Helena Voss"(EMP-002). A naive merge would union
    // it with each and TRANSITIVELY fuse the two key-distinct people. It must not.
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 'EMP-001' }),
        emp('2', 'Helena Marie Voss', null), // keyless bridge
        emp('3', 'Helena Voss', null, { employeeRef: 'EMP-002' }),
      ],
      HINTS_KEYED,
    );
    expect(clusterOf(r, '1')).not.toContain('3'); // never fused
    expect(clusterOf(r, '1')).not.toContain('2'); // bridge attaches to neither
    expect(clusterOf(r, '3')).not.toContain('2');
  });

  it('two DISTINCT numeric keys are never merged; a numeric 1 and string "1" are distinct (no bridge)', () => {
    const numeric = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 1 }),
        emp('2', 'Helena Voss', null, { employeeRef: 2 }),
      ],
      HINTS_KEYED,
    );
    expect(numeric.clusters).toHaveLength(2);
    // A numeric 1 and a string "1" are a TYPE conflict → distinct keys → a keyless
    // variant cannot bridge them (the distinctKeys/conflictingExactKey agreement).
    const coerce = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 1 }),
        emp('2', 'Ms Voss', null),
        emp('3', 'Helena Voss', null, { employeeRef: '1' }),
      ],
      HINTS_KEYED,
    );
    expect(clusterOf(coerce, '1')).not.toContain('3');
  });

  it('THE INVARIANT: no cluster ever contains two distinct exact keys (adversarial mix)', () => {
    // 3 key-distinct people sharing a surname + a spelled-out keyless bridge + two
    // under-specified keyless variants. Whatever clusters form, none may contain
    // two distinct employeeRefs — the structural never-false-merge guarantee.
    const ents = [
      emp('1', 'Helena Voss', null, { employeeRef: 'EMP-001' }),
      emp('2', 'Helena Voss', null, { employeeRef: 'EMP-002' }),
      emp('3', 'Helena Voss', null, { employeeRef: 'EMP-003' }),
      emp('4', 'Helena Marie Voss', null), // well-specified keyless bridge
      emp('5', 'Ms Voss', null), // under-specified
      emp('6', 'H. Voss', null), // initial
    ];
    const r = resolveEntities(ents, HINTS_KEYED);
    const keyOf = new Map(ents.map((e) => [e.id, e.properties.employeeRef]));
    for (const c of r.clusters) {
      const keys = new Set(
        c.memberIds.map((id) => keyOf.get(id)).filter((k): k is string => typeof k === 'string'),
      );
      expect(keys.size).toBeLessThanOrEqual(1);
    }
  });

  it('an under-specified variant stays AMBIGUOUS when ≥2 keyed identities share the surname', () => {
    // "Ms Voss" could be either Helena (EMP-001) or Bernadette (EMP-002) → it is
    // NOT auto-attached to either; it stays split for M1.3 disambiguation.
    const r = resolveEntities(
      [
        emp('1', 'Helena Voss', null, { employeeRef: 'EMP-001' }),
        emp('2', 'Bernadette Voss', null, { employeeRef: 'EMP-002' }),
        emp('3', 'Ms Voss', null),
      ],
      HINTS_KEYED,
    );
    expect(clusterOf(r, '3')).toEqual(['3']);
    expect(clusterOf(r, '1')).not.toContain('2');
  });
});

describe('resolveEntities — a non-person reference value must not force a merge (wrong-key route)', () => {
  // The exp-B case-4b / Experiment-C defect: extraction can bind a case/document
  // reference as a person's exact key. When such a ref-shaped value collides across
  // two DISTINCT people, exactKeyMatch force-merges them silently (one cluster). The
  // config declares a key pattern; a value failing it is IGNORED for identity (entity
  // kept, just keyless), so it can never force a confident merge. Context-blind
  // (contextVector: null), exactly as production resolves.
  const HINTS_KEY_PATTERN = new Map<string, EntityResolutionHints>([
    [
      'Employee',
      {
        identityProperties: ['fullName'],
        exactKeyProperties: ['employeeRef'],
        // A personnel ref is a single token with at most one hyphen segment
        // ("NET-4471", "OAK-2210", "30781"); a case ref like "INV-2026-014" (two
        // hyphen segments) is rejected.
        exactKeyPatterns: { employeeRef: '^[A-Za-z0-9]+(-[A-Za-z0-9]+)?$' },
      },
    ],
  ]);

  it('a ref-shaped value bound as the exact key does NOT force a merge (RED before fix)', () => {
    // Two DISTINCT people who share a full name; extraction grabbed the same case
    // reference as each one's employeeRef.
    const r = resolveEntities(
      [
        emp('a', 'Helena Reyes', null, { employeeRef: 'INV-2026-014' }),
        emp('b', 'Helena Reyes', null, { employeeRef: 'INV-2026-014' }),
      ],
      HINTS_KEY_PATTERN,
    );
    expect(r.clusters).toHaveLength(2); // NOT merged — the ref-shaped key is ignored
    expect(clusterOf(r, 'a')).not.toContain('b');
  });

  it('an entity whose only key value is ref-shaped is KEPT (keyless), never dropped', () => {
    const r = resolveEntities(
      [emp('lucy', 'Lucy Sandoval', null, { employeeRef: 'INV-2026-014' })],
      HINTS_KEY_PATTERN,
    );
    expect(r.clusters.flatMap((c) => c.memberIds)).toContain('lucy'); // survives
  });

  it('a VALID key still force-confirms a merge (no regression)', () => {
    const r = resolveEntities(
      [
        emp('a', 'Daniel Okafor', null, { employeeRef: 'EMP-001' }),
        emp('b', 'D. Okafor', null, { employeeRef: 'EMP-001' }),
      ],
      HINTS_KEY_PATTERN,
    );
    expect(r.clusters).toHaveLength(1); // same valid key → reunited
  });

  it('two distinct VALID keys still never merge (catastrophe guard intact)', () => {
    const r = resolveEntities(
      [
        emp('a', 'Clara Pemberton', null, { employeeRef: 'EMP-P1' }),
        emp('b', 'Clara Pemberton', null, { employeeRef: 'EMP-P2' }),
      ],
      HINTS_KEY_PATTERN,
    );
    expect(r.clusters).toHaveLength(2);
  });
});

describe('validExactKey — defensive regex compilation (length bound + try/catch)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterAll(() => warn.mockRestore());
  const hintsWith = (pattern: string): EntityResolutionHints => ({
    identityProperties: ['fullName'],
    exactKeyProperties: ['employeeRef'],
    exactKeyPatterns: { employeeRef: pattern },
  });

  it('a MALFORMED pattern does not throw and falls back to no-filtering (value accepted)', () => {
    // An unbalanced group is a compile error; must not propagate.
    const hints = hintsWith('([unterminated');
    expect(() => validExactKey('INV-2026-014', 'employeeRef', hints)).not.toThrow();
    // Treated as "no pattern" → the value is accepted as-is (not rejected).
    expect(validExactKey('INV-2026-014', 'employeeRef', hints)).toBe('INV-2026-014');
    expect(warn).toHaveBeenCalled(); // warned (once, cached thereafter)
  });

  it('an OVER-LONG pattern (> 200 chars) is ignored → no-filtering', () => {
    const hints = hintsWith(`^${'a'.repeat(250)}$`);
    expect(validExactKey('EMP-001', 'employeeRef', hints)).toBe('EMP-001'); // accepted, not crashed
  });

  it('a NORMAL pattern still filters correctly', () => {
    const hints = hintsWith('^[A-Za-z0-9]+(-[A-Za-z0-9]+)?$');
    expect(validExactKey('EMP-001', 'employeeRef', hints)).toBe('EMP-001'); // matches → valid key
    expect(validExactKey('INV-2026-014', 'employeeRef', hints)).toBeNull(); // fails → not a key
  });

  it('no pattern declared → any non-empty string is a valid key', () => {
    const hints: EntityResolutionHints = {
      identityProperties: ['fullName'],
      exactKeyProperties: ['employeeRef'],
    };
    expect(validExactKey('INV-2026-014', 'employeeRef', hints)).toBe('INV-2026-014');
    expect(validExactKey('  ', 'employeeRef', hints)).toBeNull(); // empty → not a key
  });
});

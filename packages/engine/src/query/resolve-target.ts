// resolveSubjectToGatherTarget — the single, pure, vertical-agnostic resolution
// decision that BOTH the engine's entity-centric retrieval (ContextRetriever)
// and the web's document-generation action route through. Given the caller-
// VISIBLE, already-permission-filtered subject entities and a named subject, it
// answers one question: which gather target (if any) does this name resolve to?
//
// It re-uses the M1.1 resolver + the M1.3 disambiguation contract and returns a
// discriminated outcome the caller maps to its own surface. PURE — it reads
// nothing (the caller did the permission-scoped findEntities), so a same-name
// person outside clearance can never be a candidate.
//
// WHY THIS EXISTS: this resolve → (disambiguate) → pick/present → bind-target
// sequence was duplicated, with subtle divergence, across ContextRetriever and
// the web generate action. Divergence in a fail-closed, permission-sensitive
// path is exactly where quiet bugs hide, so it lives in one place now.

import type { EntityResolutionHints } from '@muninhq/shared';
import type { GraphStore } from '../graph/graph-store';
import type { ReadContext } from '../graph/types';
import {
  type DisambiguationCandidate,
  type DisambiguationGroup,
  buildDisambiguation,
  gatherTargetForCandidate,
  gatherTargetForCluster,
  selectCandidate,
} from './disambiguation';
import type { GatherTarget } from './gather';
import {
  type ResolvableEntity,
  compatibleNames,
  isUnderspecified,
  nameTokens,
  resolveEntities,
  validExactKey,
} from './resolution';

// The resolution outcome. Each arm is mapped by the caller to its own surface:
//   • target         → gather it (ask: ground + answer; generate: run the template).
//   • disambiguation → present the same-name candidates → pick (re-resolve next turn).
//   • ambiguous      → a loose query matched MULTIPLE DISTINCT-name clusters; we
//                      cannot pick for the user. The CALLER decides what is safe:
//                      document generation asks the user to be more specific (it
//                      must target exactly one subject); Q&A falls back to the
//                      open path, which makes NO per-person completeness claim —
//                      both strictly safer than gathering one arbitrarily-chosen
//                      person and asserting completeness about them.
//   • not-found      → no visible cluster matched the named subject.
export type GatherResolution =
  | { readonly kind: 'target'; readonly target: GatherTarget; readonly subject: string }
  | {
      readonly kind: 'disambiguation';
      readonly group: DisambiguationGroup;
      readonly entitiesById: ReadonlyMap<string, ResolvableEntity>;
      readonly pickWasStale: boolean;
    }
  | { readonly kind: 'ambiguous'; readonly matches: readonly string[] }
  | { readonly kind: 'not-found' };

export interface ResolveSubjectInput {
  // The caller-VISIBLE entities of the subject type(s) — already permission-
  // filtered by the caller's findEntities. The resolver reads nothing further.
  readonly resolvable: readonly ResolvableEntity[];
  // The named subject to resolve (Q&A: the classified subjectKey; generation: the
  // user-typed subject query). Matched case-insensitively as a substring of a
  // cluster's logical key.
  readonly subjectKey: string;
  // The subject entity type, used to bind a single resolved cluster to its target.
  readonly entityType: string;
  readonly hintsByType: ReadonlyMap<string, EntityResolutionHints>;
  // A disambiguation selection token from a prior turn (the "pick"). Absent on
  // the first turn.
  readonly pick?: string;
}

/**
 * Resolve a named subject to a gather target (or a disambiguation / ambiguous /
 * not-found outcome) over an already-fetched, permission-filtered visible set.
 * Pure; vertical-agnostic — the subject types + identity hooks come from config.
 */
export function resolveSubjectToGatherTarget(input: ResolveSubjectInput): GatherResolution {
  const { resolvable, subjectKey, entityType, hintsByType, pick } = input;
  const resolution = resolveEntities(resolvable, hintsByType);
  const byId = new Map(resolvable.map((e) => [e.id, e]));
  const disResult = buildDisambiguation(resolution, resolvable, hintsByType);
  const q = subjectKey.toLowerCase();
  const matchingGroup = disResult.groups.find((g) =>
    g.candidates.some((c) => c.logicalKey.toLowerCase().includes(q)),
  );

  // --- PICK path (the user chose a candidate; re-resolved under the CURRENT,
  // permission-scoped visible set) ---
  if (pick) {
    const chosen = selectCandidate(disResult, pick);
    if (!chosen) {
      // Stale token — the visible set changed since present. Re-present rather
      // than guess; if the group is gone entirely, it can no longer be resolved.
      if (matchingGroup) {
        return {
          kind: 'disambiguation',
          group: matchingGroup,
          entitiesById: byId,
          pickWasStale: true,
        };
      }
      return { kind: 'not-found' };
    }
    return {
      kind: 'target',
      target: gatherTargetForCandidate(chosen, byId, hintsByType),
      subject: chosen.logicalKey,
    };
  }

  // --- PRESENT path (first turn): same-name collision → ask the caller to pick.
  // PRECISION first: a WELL-SPECIFIED full-name query that pins exactly ONE
  // identity in the group is not a genuine collision — the other members are that
  // same person's own name-form variants, stranded only because an unrelated
  // same-surname person made the surname block multi-identity (M1.1's conservative
  // transitive-bridge guard). Resolve it cleanly instead of asking a person to
  // disambiguate themselves. Falls through to disambiguation when genuinely
  // ambiguous (≥2 distinct same-name identities). ---
  if (matchingGroup) {
    const refined = refineToSingleIdentity(
      matchingGroup,
      subjectKey,
      entityType,
      byId,
      hintsByType,
    );
    if (refined) {
      return { kind: 'target', target: refined.target, subject: refined.subject };
    }
    return {
      kind: 'disambiguation',
      group: matchingGroup,
      entitiesById: byId,
      pickWasStale: false,
    };
  }

  // --- Single named identity → its gather target. A loose query matching SEVERAL
  // distinct-name clusters is `ambiguous` (the caller decides); none → not-found. ---
  const matches = resolution.clusters.filter((c) => c.logicalKey.toLowerCase().includes(q));
  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length > 1) return { kind: 'ambiguous', matches: matches.map((c) => c.logicalKey) };
  const [cluster] = matches;
  if (!cluster) return { kind: 'not-found' };
  return {
    kind: 'target',
    target: gatherTargetForCluster(entityType, cluster.memberIds, byId, hintsByType),
    subject: cluster.logicalKey,
  };
}

// ---------------------------------------------------------------------------
// Same-name-collision precision (the false-collision fix)
// ---------------------------------------------------------------------------
// At scale a surname collides across unrelated people, so M1.1's surname BLOCK is
// "multi-identity" and its conservative transitive-bridge guard leaves a queried
// person's mentions UNMERGED across several clusters (one may bear the exact key,
// the rest are keyless / under-specified name forms). buildDisambiguation groups
// them by name, so a query that names ONE person ("Karen", "Grace O'Brien",
// "Mr Voss") surfaces as a disambiguation of that person against THEIR OWN
// mentions — a false collision that strands the query on the open (fuzzy) path
// instead of gather-by-identity. This is the 20-of-28 case.
//
// THE DECISION, using "the name + disambiguating attributes":
//   • the query NAMES a set of candidate clusters (same substring basis as the
//     group match above — so a partial/title/first-name query like "Mr Voss" or
//     "Grace" selects exactly the clusters whose representative form it names);
//   • GENUINE collision → disambiguation (return null): two named clusters that a
//     disambiguating attribute proves are different people — a conflicting exact
//     KEY or distinguishing property (two "Sarah" with keys EMP-…724/…848 at
//     different departments). The caller must pick.
//   • FALSE collision → resolve: the named clusters carry NO conflicting
//     attribute → ONE person, mentions fragmented by the sparse key. Collapse and
//     gather. A full-name query additionally absorbs the person's name-compatible
//     under-specified variants ("Helena Voss" → its "H. Voss" mentions) when they
//     are uniquely this person's and non-conflicting.
//
// SAFE BY CONSTRUCTION — never mis-attributes two distinct people: a key/attribute
// CONFLICT among the named clusters is the positive evidence of a real split and
// forces disambiguation; key comparison is pattern-validated, so a case/document
// reference an extractor mis-grabbed as a ref cannot fake a conflict. Non-
// destructive: it selects a gather target over the already-permission-filtered
// visible set; it NEVER merges stored rows (the M1.1 never-false-merge core is
// untouched), and the gather itself stays permission-correct.
function refineToSingleIdentity(
  group: DisambiguationGroup,
  subjectKey: string,
  entityType: string,
  byId: ReadonlyMap<string, ResolvableEntity>,
  hintsByType: ReadonlyMap<string, EntityResolutionHints>,
): { target: GatherTarget; subject: string } | null {
  const q = subjectKey.toLowerCase().trim();
  if (q === '') return null;
  const hints = hintsByType.get(entityType);
  const tokensOf = (c: DisambiguationCandidate): string[] => nameTokens(c.logicalKey);

  // The clusters the query NAMES (the same substring basis the group was matched
  // on) — for a partial query this is the literal form, e.g. "mr voss" names only
  // the "Mr Voss" clusters, not "Helena Voss".
  const named = group.candidates.filter((c) => c.logicalKey.toLowerCase().includes(q));
  if (named.length === 0) return null;

  // POSITIVE-ANCHOR rule. Collapse a same-name group to one person ONLY when a
  // single valid exact key anchors the identity — that key positively says "these
  // mentions are the same person", and name-matching keyless mentions attach to
  // it (the sparse-key fragmentation case). With NO key the named clusters carry
  // no positive evidence they are one person rather than two who share a name, so
  // we must NOT silently merge them — disambiguation is the safe answer (it is
  // also what keeps the engine from conflating two real same-name employees).
  const keyProp = hints?.exactKeyProperties?.[0];
  const anchorKeys = new Set<string>();
  if (keyProp) {
    for (const c of named) {
      for (const m of membersOf(c, byId)) {
        const v = validExactKey(m.properties[keyProp], keyProp, hints);
        if (v !== null) anchorKeys.add(v);
      }
    }
  }
  if (anchorKeys.size === 0) return null; // no positive identity anchor → disambiguate

  // GENUINE collision: any two named clusters a disambiguating attribute proves
  // are different people (e.g. two distinct keys, or different departments) → the
  // caller must pick.
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i];
      const b = named[j];
      if (a === undefined || b === undefined) continue;
      if (conflictingAttribute(membersOf(a, byId), membersOf(b, byId), hints)) return null;
    }
  }

  // No conflict → the named clusters are one fragmented person. Collapse them.
  const memberIds = new Set<string>();
  const identityMembers: ResolvableEntity[] = [];
  for (const c of named) {
    for (const id of c.memberIds) memberIds.add(id);
    identityMembers.push(...membersOf(c, byId));
  }

  // A FULL-NAME query also pulls in this person's under-specified mentions that
  // the substring did not name ("Helena Voss" → "H. Voss"), but only when the
  // variant is name-compatible with the query, is NOT also compatible with a
  // DIFFERENT full-name person in the group ("Ms Voss" when a Marcus Voss exists),
  // and carries no conflicting attribute.
  const qTokens = nameTokens(subjectKey);
  if (qTokens.length > 0 && !isUnderspecified(qTokens)) {
    const otherFullNames = group.candidates.filter(
      (c) => !named.includes(c) && !isUnderspecified(tokensOf(c)),
    );
    for (const c of group.candidates) {
      if (named.includes(c)) continue;
      const ct = tokensOf(c);
      if (!isUnderspecified(ct)) continue; // only under-specified variants
      if (!compatibleNames(qTokens, ct)) continue;
      if (otherFullNames.some((o) => compatibleNames(ct, tokensOf(o)))) continue;
      if (conflictingAttribute(membersOf(c, byId), identityMembers, hints)) continue;
      for (const id of c.memberIds) memberIds.add(id);
    }
  }

  // Prefer the most specific named form as the display subject.
  const subject = named.reduce((best, c) =>
    tokensOf(c).length > tokensOf(best).length ? c : best,
  ).logicalKey;
  return { target: gatherTargetForCluster(entityType, [...memberIds], byId, hintsByType), subject };
}

function membersOf(
  c: DisambiguationCandidate,
  byId: ReadonlyMap<string, ResolvableEntity>,
): ResolvableEntity[] {
  return c.memberIds
    .map((id) => byId.get(id))
    .filter((e): e is ResolvableEntity => e !== undefined);
}

// Positive evidence that two member sets are DIFFERENT people: a distinguishing
// or exact-key property whose non-empty values are FULLY DISJOINT across the two
// sets (e.g. one is department=Northgate, the other department=Westfield; or keys EMP-1
// vs EMP-2). A shared or missing value is not evidence of distinctness. Generic —
// the properties come from the configuration identity hooks (Rule 1). Exact-key
// values are pattern-VALIDATED (validExactKey), so a case/document reference an
// extractor mis-grabbed as a ref (e.g. "PS-2026-1181", failing the ref pattern)
// counts as absent and cannot fabricate a conflict between two of one person's
// mentions — mirroring the resolver's own wrong-key guard.
function conflictingAttribute(
  a: readonly ResolvableEntity[],
  b: readonly ResolvableEntity[],
  hints: EntityResolutionHints | undefined,
): boolean {
  const keyProps = new Set(hints?.exactKeyProperties ?? []);
  const props = [...(hints?.distinguishingProperties ?? []), ...keyProps];
  for (const p of props) {
    const validated = keyProps.has(p);
    const av = nonEmptyValues(a, p, validated ? hints : undefined, p);
    const bv = nonEmptyValues(b, p, validated ? hints : undefined, p);
    if (av.size === 0 || bv.size === 0) continue;
    let overlap = false;
    for (const v of av) {
      if (bv.has(v)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) return true; // both present, fully disjoint → distinct people
  }
  return false;
}

// Distinct non-empty string values of `prop` across members. When `hints`+`keyProp`
// are given the value is run through validExactKey first, so a pattern-failing key
// is treated as absent (never a conflict signal).
function nonEmptyValues(
  members: readonly ResolvableEntity[],
  prop: string,
  hints?: EntityResolutionHints,
  keyProp?: string,
): Set<string> {
  const out = new Set<string>();
  for (const m of members) {
    const raw = m.properties[prop];
    const v = hints && keyProp ? validExactKey(raw, keyProp, hints) : raw;
    if (typeof v === 'string' && v.trim() !== '') out.add(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out.add(String(v));
  }
  return out;
}

// The visible subject set, or an honest "truncated" signal. Callers must NOT
// resolve on a truncated set — it could miss the subject or partial-gather a
// cluster — so they fall back to a safe path (Q&A: open vector; generation: a
// "narrow the subject" error) rather than silently guess.
export type ResolvableSubjects =
  | { readonly kind: 'ok'; readonly resolvable: ResolvableEntity[] }
  | { readonly kind: 'truncated' };

/**
 * Load the caller-visible entities of the given subject types as a resolvable
 * set (permission-scoped — the read runs under `ctx`, so out-of-clearance rows
 * never enter resolution). Returns `truncated` when the visible page is capped.
 */
export async function loadResolvableSubjects(
  store: GraphStore,
  ctx: ReadContext,
  types: readonly string[],
  limit = 5000,
): Promise<ResolvableSubjects> {
  const page = await store.findEntities(ctx, { types, limit });
  if (page.total > page.items.length) return { kind: 'truncated' };
  return {
    kind: 'ok',
    resolvable: page.items.map((e) => ({
      id: e.id,
      type: e.type,
      properties: e.properties,
      contextVector: null,
    })),
  };
}

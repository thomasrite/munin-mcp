// Question classification (G1 / F31) — GENERIC, vertical-agnostic.
//
// THE PROBLEM (F31): the Q&A path answers from vector top-k, which under-retrieves
// a PER-PERSON question ("everything about X") at scale and can silently return an
// incomplete answer. The fix routes such questions through the identity flow
// (resolve → disambiguate → gather → ground). This module is the ROUTER.
//
// ROUTE ON ENTITY-PRESENCE, NOT PHRASING (acceptance bar 1): a question is
// entity-centric iff it NAMES A SUBJECT THAT RESOLVES TO AN ENTITY the caller can
// see — decided by resolving the caller-visible subject entities (M1.1) and
// testing whether the question text names one of them. There are NO hardcoded
// wording patterns ("everything about", "summarise", …) and NO vertical terms; the
// subject entity types and the identity hook come from configuration.
//
// FAIL SAFE (acceptance bar 2): the engine NEVER asserts completeness it did not
// earn. This classifier only ever moves a question TOWARD the identity path; it
// never diverts a plausibly-personal question to vector-only. When a name is
// matched the result is `entity-centric` (gather + a SPECIFIC banner); the only
// `open` result is when NO visible subject is named at all. The pipeline then
// applies the invariant: completeness is asserted only when gather actually ran.
//
// PURE: no I/O, no bypass. Operates over the already-visible resolvable entities
// the caller passes (permission-correct by construction — an out-of-clearance
// same-name person is never in the set, so is never named/offered).

import type { EntityResolutionHints } from '@muninhq/shared';
import {
  type LogicalCluster,
  type ResolvableEntity,
  compatibleNames,
  nameTokens,
  resolveEntities,
} from './resolution';

// Tokenise the free-text QUESTION for name-mention matching. Stronger than the
// resolver's name tokeniser: questions carry arbitrary punctuation ("Voss?",
// "(Cole)"), so we strip every non-alphanumeric to word boundaries before
// matching — otherwise "voss?" would not equal the cluster token "voss". The
// resolver's nameTokens stays unchanged (it tokenises clean stored names).
function questionTokens(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export interface ClassifyQuestionInput {
  readonly question: string;
  // The caller-VISIBLE entities of the configured subject types (already
  // permission-filtered by the caller; the classifier reads nothing).
  readonly entities: readonly ResolvableEntity[];
  // Per-type identity hooks (config `EntityResolutionHints`). Identity properties
  // drive the resolver's name-compatibility; the classifier names no property.
  readonly hintsByType: ReadonlyMap<string, EntityResolutionHints>;
}

export type QuestionClassification =
  | {
      // No visible subject is named — answer via the open vector path. Safe to do
      // so precisely because no per-person completeness claim is implied.
      readonly kind: 'open';
    }
  | {
      // The question names a visible subject. Route through gather; if >1 cluster
      // shares the named identity (same-name people), disambiguate first.
      readonly kind: 'entity-centric';
      readonly entityType: string;
      // The named identity, for display + the SPECIFIC completeness banner.
      readonly subjectKey: string;
      // The logical clusters whose identity the question named. One → gather it.
      // More than one (same name) → the web layer disambiguates (present → pick).
      readonly clusters: readonly LogicalCluster[];
    };

// A cluster's identity is "named" by the question when:
//   (1) its SURNAME (last name token) appears in the question, AND
//   (2) at least one GIVEN-name token is corroborated — the question contains the
//       same token or a compatible INITIAL ("h" ↔ "helena"), using the resolver's
//       initial-compatibility rule.
//
// Requiring given-name corroboration (not the bare surname) is the near-miss
// guard: an unrelated surname-like word in prose ("cole storage") does not
// corroborate the given name "Adrian", so it falls through to `open`. That is the
// SAFE direction: the open vector path makes NO per-person completeness claim, so
// it cannot violate the invariant (no incomplete-AND-unbanned answer). Conversely
// any form that DOES corroborate the name ("Helena Voss" / "H. Voss") routes to
// gather, where completeness is asserted only because a real gather ran.
function corroborates(questionToks: readonly string[], given: string): boolean {
  return questionToks.some(
    (q) =>
      q === given ||
      (q.length === 1 && given.startsWith(q)) || // "h" corroborates "helena"
      (given.length === 1 && q.startsWith(given)),
  );
}
function questionNamesCluster(questionToks: readonly string[], cluster: LogicalCluster): boolean {
  const nameToks = nameTokens(cluster.logicalKey);
  const surname = nameToks.at(-1);
  if (surname === undefined) return false;
  if (!questionToks.includes(surname)) return false;
  const given = nameToks.slice(0, -1);
  // A surname-only identity (no given name on record) matches on the surname; an
  // identity WITH a given name needs that given name corroborated in the question.
  if (given.length === 0) return true;
  return given.some((g) => corroborates(questionToks, g));
}

/**
 * Classify a question as open (vector path) or entity-centric (identity path).
 * Routes on entity-presence: resolve the visible subject entities and test
 * whether the question names one of them. Pure; vertical-agnostic.
 */
export function classifyQuestion(input: ClassifyQuestionInput): QuestionClassification {
  if (input.entities.length === 0) return { kind: 'open' };

  const { clusters } = resolveEntities(input.entities, input.hintsByType);
  const questionToks = questionTokens(input.question);
  if (questionToks.length === 0) return { kind: 'open' };

  // Which clusters does the question name?
  const named = clusters.filter((c) => questionNamesCluster(questionToks, c));
  if (named.length === 0) return { kind: 'open' };

  // The entity type of the named subject(s). Resolution clusters are per-type
  // (the resolver never merges across types), and the entity carrying a cluster
  // member determines the type.
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const typeOf = (c: LogicalCluster): string | undefined =>
    c.memberIds.map((id) => byId.get(id)?.type).find((t): t is string => t !== undefined);

  // Group the named clusters by SHARED identity (same type + name-compatible
  // representative names) — the M1.3 same-name collision. A single shared
  // identity (one or many same-name clusters) is one subject to gather/disambiguate.
  // If the question named TWO DISTINCT identities (different surnames), we cannot
  // pick for the user; fail safe to the FIRST named identity's group so the
  // answer is still gathered + specifically banned, never silent vector-only.
  const first = named[0];
  if (first === undefined) return { kind: 'open' };
  const firstType = typeOf(first);
  if (firstType === undefined) return { kind: 'open' };
  const firstToks = nameTokens(first.logicalKey);
  const sameIdentity = named.filter(
    (c) => typeOf(c) === firstType && compatibleNames(firstToks, nameTokens(c.logicalKey)),
  );

  return {
    kind: 'entity-centric',
    entityType: firstType,
    subjectKey: first.logicalKey,
    clusters: sameIdentity,
  };
}

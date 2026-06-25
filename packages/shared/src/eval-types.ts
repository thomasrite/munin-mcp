// Generic evaluation-harness types — vertical-agnostic.
//
// These describe a labelled corpus ("ground truth") for measuring whether the
// engine extracts and answers correctly against a known dataset. They live in
// shared (not engine, not a configuration) so the engine's generic acceptance
// harness and any configuration's demo data can share the vocabulary without a
// dependency cycle. Nothing here knows about any vertical: entities are
// identified by an opaque `type` string and a stable `key`; access tags are
// opaque strings.

export interface EvalEntity {
  // Opaque entity-type name (matches a configured entity type, e.g. "Project").
  readonly type: string;
  // Stable identifying value of the entity (e.g. a person's full name, a
  // project's name, a task's title). The scorer matches on (type, key).
  readonly key: string;
}

export interface EvalRelationship {
  readonly type: string;
  readonly fromKey: string;
  readonly toKey: string;
}

export interface EvalDocument {
  // Basename of the document file within the corpus directory.
  readonly file: string;
  // Opaque access tags applied to the document at ingest (e.g. ["demo:public"]).
  readonly accessTags: readonly string[];
  readonly entities: readonly EvalEntity[];
  readonly relationships: readonly EvalRelationship[];
}

export interface EvalQuestion {
  readonly id: string;
  // Opaque caller access tags (pre-expansion) the question is asked under.
  readonly callerBaseTags: readonly string[];
  readonly question: string;
  // A human-written, falsifiable prediction of the correct answer.
  readonly predictedAnswer: string;
  readonly expectedStatus: 'answered' | 'no_evidence';
  // Document basenames a correct answer should cite (at least one of).
  readonly shouldCiteAnyOf?: readonly string[];
  // Substrings that must NOT appear in the answer (leakage / out-of-clearance).
  readonly mustNotMention?: readonly string[];
  // Terms a complete answer should aggregate (e.g. the duplication probe).
  readonly shouldMentionAll?: readonly string[];
}

export interface EvalGroundTruth {
  readonly documents: readonly EvalDocument[];
  // Distinct logical entities per type — the denominator for the duplication
  // fragmentation metric. Keyed by opaque entity-type name.
  readonly logicalEntities: Readonly<Record<string, readonly string[]>>;
  // Which property of each entity type holds its stable `key` (e.g.
  // Person→"fullName", Project→"name"). Lets the generic scorer extract the key
  // from an entity's property bag without knowing any vertical specifics.
  readonly keyProperties: Readonly<Record<string, string>>;
  readonly questions: readonly EvalQuestion[];
}

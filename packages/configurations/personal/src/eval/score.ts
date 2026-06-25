// Pure scorer for the personal extraction eval: distinct-set precision/recall
// per entity type, overall, and over relationships, against ground-truth.ts.
//
// Matching is on (type, normalised key): lowercase, whitespace collapsed,
// surrounding quotes stripped, one leading article stripped. An expected
// entity may list tight aliases; an extracted key matching the canonical key
// OR any alias counts as that entity (and duplicates of one logical entity
// collapse — fragmentation is reported separately by row count).

import { personalGroundTruth, personalKeyProperties } from './ground-truth';

export interface ExtractedEntityLike {
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface ExtractedRelationshipLike {
  readonly type: string;
  readonly from: ExtractedEntityLike;
  readonly to: ExtractedEntityLike;
}

export interface TypeScore {
  readonly expected: number;
  readonly matched: number;
  readonly extractedDistinct: number;
  readonly precision: number;
  readonly recall: number;
}

export interface PersonalEvalScore {
  readonly perType: Readonly<Record<string, TypeScore>>;
  readonly entityOverall: TypeScore;
  readonly relationships: TypeScore;
  // Qualitative review hooks: what was extracted but not expected, and what
  // was expected but never extracted ("Type:key" / "type fromKey->toKey").
  readonly unexpectedEntities: readonly string[];
  readonly missedEntities: readonly string[];
  readonly unexpectedRelationships: readonly string[];
  readonly missedRelationships: readonly string[];
}

export function normaliseKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  s = s.replace(/^['"'']+|['"'']+$/g, '');
  s = s.replace(/^(the|a|an) /, '');
  return s.trim();
}

function keyOf(e: ExtractedEntityLike): string {
  const prop = personalKeyProperties[e.type];
  return prop === undefined ? '' : normaliseKey(e.properties[prop]);
}

function ratio(n: number, d: number): number {
  return d === 0 ? 1 : n / d;
}

function score(expected: number, matched: number, extractedDistinct: number): TypeScore {
  return {
    expected,
    matched,
    extractedDistinct,
    precision: ratio(matched, extractedDistinct),
    recall: ratio(matched, expected),
  };
}

// alias-or-key (normalised) → canonical key, per entity type.
function buildAliasIndex(): Map<string, Map<string, string>> {
  const byType = new Map<string, Map<string, string>>();
  for (const doc of personalGroundTruth) {
    for (const e of doc.entities) {
      const index = byType.get(e.type) ?? new Map<string, string>();
      index.set(normaliseKey(e.key), e.key);
      for (const a of e.aliases ?? []) index.set(normaliseKey(a), e.key);
      byType.set(e.type, index);
    }
  }
  return byType;
}

export function scoreExtraction(input: {
  readonly entities: readonly ExtractedEntityLike[];
  readonly relationships: readonly ExtractedRelationshipLike[];
}): PersonalEvalScore {
  const aliasIndex = buildAliasIndex();

  // Expected distinct logical entities, per type, by canonical key.
  const expectedByType = new Map<string, Set<string>>();
  for (const doc of personalGroundTruth) {
    for (const e of doc.entities) {
      const set = expectedByType.get(e.type) ?? new Set<string>();
      set.add(e.key);
      expectedByType.set(e.type, set);
    }
  }

  // Extracted distinct (type, canonical-or-raw normalised key) pairs.
  const extractedByType = new Map<string, Set<string>>();
  for (const e of input.entities) {
    const norm = keyOf(e);
    if (norm === '') continue;
    const canonical = aliasIndex.get(e.type)?.get(norm) ?? norm;
    const set = extractedByType.get(e.type) ?? new Set<string>();
    set.add(canonical);
    extractedByType.set(e.type, set);
  }

  const perType: Record<string, TypeScore> = {};
  const unexpectedEntities: string[] = [];
  const missedEntities: string[] = [];
  const allTypes = new Set([...expectedByType.keys(), ...extractedByType.keys()]);
  let totalExpected = 0;
  let totalMatched = 0;
  let totalExtracted = 0;
  for (const type of [...allTypes].sort()) {
    const expected = expectedByType.get(type) ?? new Set<string>();
    const extracted = extractedByType.get(type) ?? new Set<string>();
    let matched = 0;
    for (const key of extracted) {
      if (expected.has(key)) matched++;
      else unexpectedEntities.push(`${type}:${key}`);
    }
    for (const key of expected) {
      if (!extracted.has(key)) missedEntities.push(`${type}:${key}`);
    }
    perType[type] = score(expected.size, matched, extracted.size);
    totalExpected += expected.size;
    totalMatched += matched;
    totalExtracted += extracted.size;
  }

  // Relationships: distinct (type, canonical fromKey, canonical toKey).
  const expectedRels = new Set<string>();
  for (const doc of personalGroundTruth) {
    for (const r of doc.relationships) {
      expectedRels.add(`${r.type}|${r.fromKey}|${r.toKey}`);
    }
  }
  const extractedRels = new Set<string>();
  for (const r of input.relationships) {
    const fromNorm = keyOf(r.from);
    const toNorm = keyOf(r.to);
    if (fromNorm === '' || toNorm === '') continue;
    const fromCanonical = aliasIndex.get(r.from.type)?.get(fromNorm) ?? fromNorm;
    const toCanonical = aliasIndex.get(r.to.type)?.get(toNorm) ?? toNorm;
    extractedRels.add(`${r.type}|${fromCanonical}|${toCanonical}`);
  }
  let relMatched = 0;
  const unexpectedRelationships: string[] = [];
  const missedRelationships: string[] = [];
  for (const key of extractedRels) {
    if (expectedRels.has(key)) relMatched++;
    else unexpectedRelationships.push(key.replaceAll('|', ' '));
  }
  for (const key of expectedRels) {
    if (!extractedRels.has(key)) missedRelationships.push(key.replaceAll('|', ' '));
  }

  return {
    perType,
    entityOverall: score(totalExpected, totalMatched, totalExtracted),
    relationships: score(expectedRels.size, relMatched, extractedRels.size),
    unexpectedEntities,
    missedEntities,
    unexpectedRelationships,
    missedRelationships,
  };
}

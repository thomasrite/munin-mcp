// Unit tests for the eval module: ground-truth internal consistency (so a
// manifest typo can never masquerade as a model failure) and the scorer's
// matching/normalisation behaviour.

import { describe, expect, it } from 'vitest';

import { personalConfiguration as cfg } from '../index';
import { paragraphsOf, personalEvalCorpus } from './corpus';
import { personalGroundTruth, personalKeyProperties } from './ground-truth';
import { normaliseKey, scoreExtraction } from './score';

describe('ground-truth consistency', () => {
  it('covers exactly the corpus files', () => {
    expect(personalGroundTruth.map((d) => d.file).sort()).toEqual(
      personalEvalCorpus.map((d) => d.file).sort(),
    );
  });

  it('uses only entity types the configuration declares, with real key properties', () => {
    const declared = new Map(cfg.entityTypes.map((e) => [e.name, e]));
    for (const doc of personalGroundTruth) {
      for (const e of doc.entities) {
        const def = declared.get(e.type);
        expect(def, `${doc.file}: undeclared entity type ${e.type}`).toBeDefined();
        const keyProp = personalKeyProperties[e.type];
        expect(keyProp, `no key property mapped for ${e.type}`).toBeDefined();
        expect(Object.keys(def?.propertySchema.properties ?? {})).toContain(keyProp);
      }
    }
  });

  it('every relationship endpoint names an entity of a permitted type in the same document', () => {
    const relTypes = new Map(cfg.relationshipTypes.map((r) => [r.name, r]));
    for (const doc of personalGroundTruth) {
      const byKey = new Map(doc.entities.map((e) => [e.key, e]));
      for (const r of doc.relationships) {
        const def = relTypes.get(r.type);
        expect(def, `${doc.file}: undeclared relationship ${r.type}`).toBeDefined();
        const from = byKey.get(r.fromKey);
        const to = byKey.get(r.toKey);
        expect(from, `${doc.file}: ${r.type} fromKey '${r.fromKey}' not in doc`).toBeDefined();
        expect(to, `${doc.file}: ${r.type} toKey '${r.toKey}' not in doc`).toBeDefined();
        expect(def?.fromTypes).toContain(from?.type);
        expect(def?.toTypes).toContain(to?.type);
      }
    }
  });

  it('every corpus document splits into at least one paragraph', () => {
    for (const doc of personalEvalCorpus) {
      expect(paragraphsOf(doc).length, doc.file).toBeGreaterThanOrEqual(1);
    }
  });

  it('the two restraint documents expect zero entities', () => {
    const empty = personalGroundTruth.filter((d) => d.entities.length === 0);
    expect(empty.map((d) => d.file).sort()).toEqual([
      'journal-2026-01-18.md',
      'journal-2026-04-02.md',
    ]);
  });
});

describe('normaliseKey', () => {
  it('lowercases, trims, collapses whitespace, strips quotes and one leading article', () => {
    expect(normaliseKey('  The  Quiet   Orchard ')).toBe('quiet orchard');
    expect(normaliseKey("'Paper Lantern'")).toBe('paper lantern');
    expect(normaliseKey('A darkroom conversion')).toBe('darkroom conversion');
    expect(normaliseKey(42)).toBe('');
    expect(normaliseKey(undefined)).toBe('');
  });
});

describe('scoreExtraction', () => {
  it('scores a perfect extraction at 100% precision and recall', () => {
    const entities = personalGroundTruth.flatMap((d) =>
      d.entities.map((e) => {
        const keyProp = personalKeyProperties[e.type] ?? 'name';
        return { type: e.type, properties: { [keyProp]: e.key } };
      }),
    );
    const entityFor = (type: string, key: string) => {
      const keyProp = personalKeyProperties[type] ?? 'name';
      return { type, properties: { [keyProp]: key } };
    };
    const relationships = personalGroundTruth.flatMap((d) =>
      d.relationships.map((r) => {
        const from = d.entities.find((e) => e.key === r.fromKey);
        const to = d.entities.find((e) => e.key === r.toKey);
        if (!from || !to) throw new Error('inconsistent ground truth');
        return {
          type: r.type,
          from: entityFor(from.type, from.key),
          to: entityFor(to.type, to.key),
        };
      }),
    );
    const s = scoreExtraction({ entities, relationships });
    expect(s.entityOverall.precision).toBe(1);
    expect(s.entityOverall.recall).toBe(1);
    expect(s.relationships.precision).toBe(1);
    expect(s.relationships.recall).toBe(1);
    expect(s.unexpectedEntities).toEqual([]);
    expect(s.missedEntities).toEqual([]);
  });

  it('credits aliases and collapses duplicates of one logical entity', () => {
    const s = scoreExtraction({
      entities: [
        { type: 'Project', properties: { name: 'darkroom conversion' } },
        { type: 'Project', properties: { name: 'the darkroom' } }, // alias of the same project
      ],
      relationships: [],
    });
    expect(s.perType.Project?.matched).toBe(1);
    expect(s.perType.Project?.extractedDistinct).toBe(1);
  });

  it('counts unexpected extractions against precision and misses against recall', () => {
    const s = scoreExtraction({
      entities: [
        { type: 'Person', properties: { fullName: 'Imogen' } },
        { type: 'Person', properties: { fullName: 'Nobody Realname' } },
      ],
      relationships: [
        {
          type: 'authoredBy',
          from: { type: 'Source', properties: { title: 'Salt Roads North' } },
          to: { type: 'Person', properties: { fullName: 'Theo' } }, // Theo picked it, didn't write it
        },
      ],
    });
    expect(s.perType.Person?.matched).toBe(1);
    expect(s.perType.Person?.extractedDistinct).toBe(2);
    expect(s.unexpectedEntities).toContain('Person:nobody realname');
    expect(s.relationships.matched).toBe(0);
    expect(s.unexpectedRelationships).toHaveLength(1);
    expect(s.missedEntities.length).toBeGreaterThan(0);
  });

  it('ignores extracted entities whose key property is missing or empty', () => {
    const s = scoreExtraction({
      entities: [{ type: 'Person', properties: { role: 'editor' } }],
      relationships: [],
    });
    expect(s.perType.Person?.extractedDistinct).toBe(0);
  });
});

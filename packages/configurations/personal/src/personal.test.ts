// Validity test for the personal configuration: a well-formed Configuration
// that composes + hashes stably, satisfies the no-admin-lockout invariant,
// carries the load-bearing 'personal' tag on its single role, and whose
// write-side tag composer behaves (real class → class tags; unknown → []).

import {
  MANAGE_TENANT,
  REVIEW_CORRECTIONS,
  computeCompositeHash,
  computeSchemaHash,
} from '@muninhq/shared';
import { describe, expect, it } from 'vitest';

import { personalConfiguration as cfg, writeTagsForClass } from './index';
import { sensitivityClasses } from './sensitivity';

describe('@muninhq/config-personal', () => {
  it('declares the four conservative entity types', () => {
    expect(cfg.entityTypes.map((e) => e.name).sort()).toEqual([
      'Person',
      'Project',
      'Source',
      'Topic',
    ]);
  });

  it('has a stable id + version', () => {
    expect(cfg.id).toBe('personal');
    expect(cfg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('composes + hashes deterministically (a valid Configuration)', () => {
    const s1 = computeSchemaHash(cfg);
    const s2 = computeSchemaHash(cfg);
    const c1 = computeCompositeHash(cfg, []);
    const c2 = computeCompositeHash(cfg, []);
    expect(s1).toEqual(s2);
    expect(c1).toEqual(c2);
    expect(s1).toMatch(/^[0-9a-f]+$/);
  });

  it('ships exactly one role: the owner, holding both capabilities', () => {
    expect(cfg.roles.map((r) => r.name)).toEqual(['owner']);
    const owner = cfg.roles[0];
    expect(owner?.capabilities).toContain(MANAGE_TENANT);
    expect(owner?.capabilities).toContain(REVIEW_CORRECTIONS);
  });

  it("the owner's base tags include 'personal' (the local:init ingest tag)", () => {
    expect(cfg.roles[0]?.baseTags).toContain('personal');
  });

  it('every relationship type connects only declared entity types', () => {
    const names = new Set(cfg.entityTypes.map((e) => e.name));
    for (const rel of cfg.relationshipTypes) {
      for (const t of [...rel.fromTypes, ...rel.toTypes]) {
        expect(names, `${rel.name} references undeclared type ${t}`).toContain(t);
      }
    }
  });

  it('every entity type teaches restraint or precision via its few-shots', () => {
    for (const e of cfg.entityTypes) {
      expect(e.fewShots.length, `${e.name} needs at least 2 few-shots`).toBeGreaterThanOrEqual(2);
    }
    // At least one "extract nothing" example across the set (restraint).
    const emptyExamples = cfg.entityTypes.flatMap((e) =>
      e.fewShots.filter((f) => f.output.entities.length === 0),
    );
    expect(emptyExamples.length).toBeGreaterThanOrEqual(1);
  });

  it('few-shot relationship indexes point at real entities of the right types', () => {
    const relByName = new Map(cfg.relationshipTypes.map((r) => [r.name, r]));
    for (const e of cfg.entityTypes) {
      for (const shot of e.fewShots) {
        for (const rel of shot.output.relationships ?? []) {
          const def = relByName.get(rel.type);
          expect(def, `few-shot uses undeclared relationship ${rel.type}`).toBeDefined();
          const from = shot.output.entities[rel.fromIndex];
          const to = shot.output.entities[rel.toIndex];
          expect(from, `${rel.type} fromIndex out of range`).toBeDefined();
          expect(to, `${rel.type} toIndex out of range`).toBeDefined();
          expect(def?.fromTypes).toContain(from?.type);
          expect(def?.toTypes).toContain(to?.type);
        }
      }
    }
  });

  it('ships a single default-deny private sensitivity class on the personal tag', () => {
    expect(sensitivityClasses.map((c) => c.id)).toEqual(['private']);
    const def = sensitivityClasses[0];
    expect(def?.isDefault).toBe(true);
    expect(def?.restricted).toBe(true);
    expect(def?.accessTags).toEqual(['personal']);
  });

  it('composeWriteTags returns the class tags for the known class and [] for unknown', () => {
    expect(cfg.composeWriteTags?.({ classId: 'private', scopeTags: [] })).toEqual(['personal']);
    expect(cfg.composeWriteTags?.({ classId: 'nope', scopeTags: [] })).toEqual([]);
    expect(cfg.composeWriteTags?.({ classId: null, scopeTags: [] })).toEqual([]);
  });

  it('writeTagsForClass fails closed on an absent class list', () => {
    expect(writeTagsForClass({}, { classId: 'private', scopeTags: [] })).toEqual([]);
  });

  it('tagExpansion is the flat identity (dedup), no hierarchy', async () => {
    const out = await cfg.tagExpansion(['personal', 'personal'], { tenantId: 't' });
    expect([...out]).toEqual(['personal']);
  });
});

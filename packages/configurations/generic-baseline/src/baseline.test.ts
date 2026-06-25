// Validity test for the baseline cartridge: it is a well-formed Configuration
// that composes + hashes stably, satisfies the no-admin-lockout invariant, and
// its write-side tag composer behaves (real class → class tags; unknown → []).

import { MANAGE_TENANT, computeCompositeHash, computeSchemaHash } from '@muninhq/shared';
import { describe, expect, it } from 'vitest';

import { genericBaselineConfiguration as cfg, writeTagsForClass } from './index';
import { sensitivityClasses } from './sensitivity';

describe('@muninhq/config-generic-baseline', () => {
  it('declares the five neutral entity types', () => {
    expect(cfg.entityTypes.map((e) => e.name).sort()).toEqual([
      'Document',
      'Event',
      'Organisation',
      'Person',
      'Topic',
    ]);
  });

  it('has a stable id + version', () => {
    expect(cfg.id).toBe('generic-baseline');
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

  it('carries exactly one MANAGE_TENANT role (no-admin-lockout invariant)', () => {
    const admins = cfg.roles.filter((r) => r.capabilities?.includes(MANAGE_TENANT));
    expect(admins.map((r) => r.name)).toEqual(['admin']);
  });

  it('ships a two-class default-deny sensitivity model (default is restricted)', () => {
    expect(sensitivityClasses.map((c) => c.id)).toEqual(['restricted', 'general']);
    const def = sensitivityClasses.find((c) => c.isDefault);
    expect(def?.id).toBe('restricted');
    expect(def?.restricted).toBe(true);
  });

  it('composeWriteTags returns the class tags for a known class and [] for unknown (flat path)', () => {
    expect(cfg.composeWriteTags?.({ classId: 'restricted', scopeTags: [] })).toEqual([
      'class:restricted',
    ]);
    expect(cfg.composeWriteTags?.({ classId: 'general', scopeTags: [] })).toEqual([
      'class:general',
    ]);
    expect(cfg.composeWriteTags?.({ classId: 'nope', scopeTags: [] })).toEqual([]);
    expect(cfg.composeWriteTags?.({ classId: null, scopeTags: [] })).toEqual([]);
  });

  it('writeTagsForClass fuses scope × capability when a scope is present', () => {
    expect(
      writeTagsForClass({ sensitivityClasses }, { classId: 'restricted', scopeTags: ['dept:x'] }),
    ).toEqual(['dept:x|class:restricted']);
  });

  it('tagExpansion is the flat identity (dedup), no hierarchy', async () => {
    const out = await cfg.tagExpansion(['class:general', 'class:general', 'class:restricted'], {
      tenantId: 't',
    });
    expect([...out].sort()).toEqual(['class:general', 'class:restricted']);
  });

  it('reader sees only the open class; admin holds both (capability tags)', () => {
    const reader = cfg.roles.find((r) => r.name === 'reader');
    const admin = cfg.roles.find((r) => r.name === 'admin');
    expect(reader?.baseTags).toEqual(['class:general']);
    expect([...(admin?.baseTags ?? [])].sort()).toEqual(['class:general', 'class:restricted']);
  });
});

import { describe, expect, it } from 'vitest';

import { cartridgePackage, isKnownCartridge, knownCartridges } from './configuration-registry';

describe('configuration registry', () => {
  it('resolves the baseline id to its package', () => {
    expect(cartridgePackage('generic-baseline')).toBe('@muninhq/config-generic-baseline');
  });

  it('resolves the personal profile id to its package', () => {
    expect(cartridgePackage('personal')).toBe('@muninhq/config-personal');
  });

  it('returns undefined for an unknown / stale id (caller falls back, never crashes)', () => {
    expect(cartridgePackage('does-not-exist')).toBeUndefined();
    expect(cartridgePackage('')).toBeUndefined();
    // A closed vertical id is NOT registered in the open-core copy — it must
    // resolve to undefined (caller falls back to the env/baseline default).
    expect(cartridgePackage('mat-hr')).toBeUndefined();
    // Prototype keys must not leak through (own-property lookup only).
    expect(cartridgePackage('toString')).toBeUndefined();
    expect(cartridgePackage('__proto__')).toBeUndefined();
  });

  it('isKnownCartridge mirrors resolution', () => {
    expect(isKnownCartridge('generic-baseline')).toBe(true);
    expect(isKnownCartridge('personal')).toBe(true);
    expect(isKnownCartridge('mat-hr')).toBe(false);
    expect(isKnownCartridge('nope')).toBe(false);
    expect(isKnownCartridge('hasOwnProperty')).toBe(false);
  });

  it('knownCartridges lists every registered id with its package (and includes the baseline)', () => {
    const list = knownCartridges();
    expect(list.map((c) => c.id)).toContain('generic-baseline');
    for (const c of list) {
      expect(cartridgePackage(c.id)).toBe(c.package);
      expect(c.package.startsWith('@muninhq/config-')).toBe(true);
    }
  });
});

// Unit tests for the configuration load path (F20): the caller-provided
// resolver form, the deprecated engine-context form's clear failure message, and
// the byte-unchanged compose-at-load behaviour.

import type { Configuration, Overlay } from '@muninhq/shared';
import { describe, expect, it } from 'vitest';

import { sampleConfiguration } from '../test-support/sample-configuration';
import {
  composeTenantConfiguration,
  loadConfigurationFromPackage,
  loadConfigurationWithResolver,
} from './index';

describe('loadConfigurationWithResolver (the supported form)', () => {
  it('resolves a Configuration via a caller-provided module loader', async () => {
    const load = async (_pkg: string) => ({ configuration: sampleConfiguration });
    const config = await loadConfigurationWithResolver('@fake/pkg', load);
    expect(config.id).toBe(sampleConfiguration.id);
  });

  it('finds a default export', async () => {
    const load = async (_pkg: string) => ({ default: sampleConfiguration });
    expect((await loadConfigurationWithResolver('@fake/pkg', load)).id).toBe(
      sampleConfiguration.id,
    );
  });

  it('throws a clear error when the module exports no Configuration', async () => {
    const load = async (_pkg: string) => ({ notAConfig: 42 });
    await expect(loadConfigurationWithResolver('@fake/pkg', load)).rejects.toThrow(
      /no Configuration export found/,
    );
  });
});

describe('loadConfigurationFromPackage (deprecated engine-context form)', () => {
  it('fails with a "pass a resolver" message when the package is not engine-resolvable', async () => {
    await expect(
      loadConfigurationFromPackage('@muninhq/this-package-does-not-exist'),
    ).rejects.toThrow(/Pass a caller-provided resolver/);
  });
});

describe('composeTenantConfiguration', () => {
  const base: Configuration = sampleConfiguration;

  it('returns the base configuration byte-unchanged when there is no overlay', () => {
    expect(composeTenantConfiguration(base)).toBe(base);
    expect(composeTenantConfiguration(base, null)).toBe(base);
    // No schemaHash/compositeHash/appliedOverlays bolted on.
    expect('appliedOverlays' in composeTenantConfiguration(base)).toBe(false);
  });

  it('composes the overlay when present (terminology override + applied id)', () => {
    const overlay: Overlay = {
      id: 'ovl-x',
      version: '1.0.0',
      baseConfigurationId: base.id,
      terminology: { Person: 'Colleague' },
    };
    const composed = composeTenantConfiguration(base, overlay);
    expect(composed.terminology.Person).toBe('Colleague');
    expect('appliedOverlays' in composed).toBe(true);
  });
});

// Config-load smoke (F20): the CLIs resolve their configuration package via a
// caller-context resolver — `(p) => import(p)` runs in THIS package's module
// context, where @muninhq/config-generic-demo is a devDependency. This is the
// regression guard against the latent break the engine-context loader had
// (ERR_MODULE_NOT_FOUND when a config package is only the caller's dependency).

import { loadConfigurationWithResolver } from '@muninhq/engine';
import { describe, expect, it } from 'vitest';

describe('CLI config-load smoke', () => {
  it('resolves @muninhq/config-generic-demo from the CLI module context', async () => {
    const config = await loadConfigurationWithResolver(
      '@muninhq/config-generic-demo',
      (p) => import(p),
    );
    expect(config.entityTypes.length).toBeGreaterThan(0);
    expect(config.relationshipTypes.length).toBeGreaterThan(0);
  });
});

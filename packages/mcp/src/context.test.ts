// The single-user context builder: union of every role's baseTags, expanded
// through the configuration's tagExpansion, kind 'regular', actor pinned.

import { asTenantId } from '@muninhq/engine';
import { describe, expect, it } from 'vitest';

import { MCP_ACTOR, buildSingleUserContext, singleUserBaseTags } from './context';
import { testConfiguration } from './test-fixtures';

const TENANT = asTenantId('00000000-0000-4000-8000-000000000001');

describe('singleUserBaseTags', () => {
  it('returns the union of baseTags across every role, deduplicated', () => {
    const tags = singleUserBaseTags(testConfiguration());
    expect([...tags].sort()).toEqual(['blue', 'green', 'red']);
  });

  it('returns empty for a configuration with no roles', () => {
    expect(singleUserBaseTags(testConfiguration({ roles: [] }))).toEqual([]);
  });
});

describe('buildSingleUserContext', () => {
  it('builds a kind=regular context with expanded tags and the mcp actor', async () => {
    const ctx = await buildSingleUserContext(testConfiguration(), TENANT);
    expect(ctx.kind).toBe('regular');
    expect(ctx.tenantId).toBe(TENANT);
    expect(ctx.actor).toBe(MCP_ACTOR);
    expect([...ctx.accessTags].sort()).toEqual([
      'blue',
      'blue:expanded',
      'green',
      'green:expanded',
      'red',
      'red:expanded',
    ]);
  });

  it('supports an async tagExpansion', async () => {
    const config = testConfiguration({
      tagExpansion: async (baseTags) => baseTags.map((t) => t.toUpperCase()),
    });
    const ctx = await buildSingleUserContext(config, TENANT);
    expect([...ctx.accessTags].sort()).toEqual(['BLUE', 'GREEN', 'RED']);
  });

  it('deduplicates tags the expansion repeats', async () => {
    const config = testConfiguration({
      roles: [{ name: 'r', description: 'd', baseTags: ['a'] }],
      tagExpansion: (baseTags) => [...baseTags, ...baseTags],
    });
    const ctx = await buildSingleUserContext(config, TENANT);
    expect(ctx.accessTags).toEqual(['a']);
  });

  it('an empty role set yields an empty (sees-nothing) tag set — never a wildcard', async () => {
    const config = testConfiguration({ roles: [], tagExpansion: (t) => t });
    const ctx = await buildSingleUserContext(config, TENANT);
    expect(ctx.accessTags).toEqual([]);
  });
});

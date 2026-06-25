// Alignment cross-check (prosumer step 4): local:init prints an ingest
// command with `--tags <tag>`, and the default configuration's role base tags
// must COVER every printed tag — the MCP server reads under the union of the
// configuration roles' base tags (identity expansion), so a drift between the
// printed write tag and the configured read tags would make freshly-ingested
// documents silently invisible. This test pins the two together so neither
// can change without the other.

import personalConfiguration from '@muninhq/config-personal';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG_PACKAGE, buildNextSteps } from './local-init';

const TENANT = '6f1f1e9c-1111-4222-8333-444455556666';

function printedIngestTags(): string[] {
  const steps = buildNextSteps({
    tenantId: TENANT,
    repoRoot: '/repo',
    configPackage: DEFAULT_CONFIG_PACKAGE,
  });
  const ingestLine = steps.split('\n').find((l) => l.includes(' ingest '));
  expect(ingestLine, 'next-steps must print an ingest command').toBeDefined();
  const m = ingestLine?.match(/--tags\s+(\S+)/);
  expect(m, 'the printed ingest command must carry --tags').toBeTruthy();
  return (m?.[1] ?? '').split(',').filter((t) => t.length > 0);
}

describe('local:init default-config alignment', () => {
  it('the default config package is @muninhq/config-personal', () => {
    expect(DEFAULT_CONFIG_PACKAGE).toBe('@muninhq/config-personal');
  });

  it("the default package's role tags cover every tag the ingest command prints", async () => {
    const tags = printedIngestTags();
    expect(tags.length).toBeGreaterThan(0);

    // The MCP server's read context: union of all roles' base tags, run
    // through the configuration's own tag expansion.
    const baseUnion = personalConfiguration.roles.flatMap((r) => [...r.baseTags]);
    const expanded = await personalConfiguration.tagExpansion(baseUnion, { tenantId: TENANT });

    for (const tag of tags) {
      expect(expanded, `printed ingest tag '${tag}' is not readable by any role`).toContain(tag);
    }
  });
});

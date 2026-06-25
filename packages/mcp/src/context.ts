// The single-user permission context — THE permission story of this server.
//
// One local user owns the whole corpus, so the server builds ONE
// RegularReadContext at startup: the UNION of `baseTags` from every role the
// loaded configuration declares, expanded through the configuration's
// `tagExpansion`. Every engine read stays on the normal, fail-closed,
// tenant- and tag-filtered path.
//
// NEVER construct the engine's internal-bypass token here. It is for system
// jobs only; the
// union-of-baseTags context gives the local user full visibility of their own
// corpus without touching the bypass inventory (see zero-bypass.test.ts).

import type { RegularReadContext, TenantId } from '@muninhq/engine';
import { asActorId } from '@muninhq/engine';
import type { Configuration } from '@muninhq/shared';

export const MCP_ACTOR = 'mcp:local-user';

/** Union of `baseTags` across every role the configuration declares. */
export function singleUserBaseTags(configuration: Configuration): readonly string[] {
  const tags = new Set<string>();
  for (const role of configuration.roles) {
    for (const tag of role.baseTags) tags.add(tag);
  }
  return [...tags];
}

/**
 * Build the single-user RegularReadContext: union of role baseTags, expanded
 * through the configuration's tagExpansion, actor pinned to `mcp:local-user`.
 */
export async function buildSingleUserContext(
  configuration: Configuration,
  tenantId: TenantId,
): Promise<RegularReadContext> {
  const baseTags = singleUserBaseTags(configuration);
  const accessTags = await Promise.resolve(
    configuration.tagExpansion(baseTags, { tenantId, orgUnits: [] }),
  );
  return {
    kind: 'regular',
    tenantId,
    accessTags: [...new Set(accessTags)],
    actor: asActorId(MCP_ACTOR),
  };
}

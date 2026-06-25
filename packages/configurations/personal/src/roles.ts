import { MANAGE_TENANT, REVIEW_CORRECTIONS, role } from '@muninhq/shared';
import type { RoleDefinition } from '@muninhq/shared';

// One all-access role: a personal memory has exactly one human, who owns
// everything in it. `baseTags` MUST include 'personal' — local:init prints
// `ingest ... --tags personal`, and with identity tag expansion the MCP
// server's union-of-baseTags context sees exactly what that command writes.
// A cross-check test in munin-mcp asserts this alignment so the two can
// never drift.
//
// The owner carries MANAGE_TENANT (no-admin-lockout invariant, 2.7 Decision 7)
// and REVIEW_CORRECTIONS (P6a) — there is nobody else to delegate either to.

export const owner: RoleDefinition = role({
  name: 'owner',
  description: 'The single owner of this memory: full read access and all administration.',
  baseTags: ['personal'],
  capabilities: [MANAGE_TENANT, REVIEW_CORRECTIONS],
});

export const roles: readonly RoleDefinition[] = [owner];

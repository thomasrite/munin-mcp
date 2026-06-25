import { MANAGE_TENANT, role } from '@muninhq/shared';
import type { RoleDefinition } from '@muninhq/shared';

// The demo uses three flat roles. There is no hierarchy; the tag-expansion
// function in `tag-expansion.ts` is the identity. A real vertical (see the
// MAT sketch) would carry hierarchical tags expanded by configuration.

export const admin: RoleDefinition = role({
  name: 'admin',
  description: 'Full read access across the demo tenant.',
  baseTags: ['demo:sysadmin'],
  // Grants the admin console (2.7). The gate keys on this capability, never on
  // the role name — a config could name its admin role anything.
  capabilities: [MANAGE_TENANT],
});

export const member: RoleDefinition = role({
  name: 'member',
  description: 'Read access to non-restricted Projects, Tasks, and People.',
  baseTags: ['demo:member'],
});

export const guest: RoleDefinition = role({
  name: 'guest',
  description: 'Read access to documents tagged demo:public only.',
  baseTags: ['demo:public'],
});

export const roles: readonly RoleDefinition[] = [admin, member, guest];

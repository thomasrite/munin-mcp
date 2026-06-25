import { MANAGE_TENANT, REVIEW_CORRECTIONS, role } from '@muninhq/shared';
import type { RoleDefinition } from '@muninhq/shared';

// Two flat baseline roles. Capability tags are the sensitivity-class access tags
// (sensitivity.ts): `admin` holds both classes (and tenant admin), `reader` holds
// only the open class — so a default (restricted) upload is admin-only until it
// is widened to General. No hierarchy; the flat tagExpansion is the identity.
//
// At least one role must carry MANAGE_TENANT (the no-admin-lockout invariant,
// 2.7 Decision 7) — `admin` holds it. The gate keys on the capability, never on
// the role name. `admin` also holds REVIEW_CORRECTIONS (P6a) so it can steward
// proposed corrections — verifying them onto the shared graph; the gate keys on
// the capability the same way.

export const admin: RoleDefinition = role({
  name: 'admin',
  description:
    'Full read access across the workspace, plus tenant administration and correction review.',
  baseTags: ['class:restricted', 'class:general'],
  capabilities: [MANAGE_TENANT, REVIEW_CORRECTIONS],
});

export const reader: RoleDefinition = role({
  name: 'reader',
  description: 'Read access to General (non-restricted) documents.',
  baseTags: ['class:general'],
});

export const roles: readonly RoleDefinition[] = [admin, reader];

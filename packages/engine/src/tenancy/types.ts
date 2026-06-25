// Tenancy: control-plane tenant resolution + per-tenant operational metadata.
//
// Vertical-agnostic by construction. The engine stores and returns opaque rows
// (org-unit `kind` strings, role-name strings, tag arrays); the *meaning* —
// which role grants which tags, how org-unit kinds nest — lives entirely in the
// configuration layer. This is the D3 store the permission resolver reads to
// turn a signed-in user into an engine ReadContext.

import type { Configuration, OrgUnit, Overlay } from '@muninhq/shared';

import type { TenantId } from '../graph/types';

export type { OrgUnit };

export interface GroupRoleBinding {
  readonly subjectKind: 'app_role' | 'group';
  readonly subjectId: string;
  readonly roleName: string;
  readonly scopeOrgUnitId: string | null;
}

export interface UserUnitAssignment {
  readonly actorOid: string;
  readonly orgUnitId: string;
  readonly roleName: string | null;
}

// An org unit to upsert. The `id` is CALLER-SUPPLIED (not auto-generated) so the
// caller can wire `parentId` → child deterministically and so re-running a seed
// is idempotent (update-in-place by id). All fields are opaque to the engine.
export interface NewOrgUnit {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly label: string;
  readonly tags: readonly string[];
}

// A user→org-unit assignment to upsert. Natural key is (tenant, actorOid,
// orgUnitId); `roleName` is updatable metadata, not part of the key.
export interface NewUserUnitAssignment {
  readonly actorOid: string;
  readonly orgUnitId: string;
  readonly roleName?: string | null;
}

// Control-plane mapping: Entra tenant id → Munin tenant. Resolved BEFORE any
// tenant-DB connection (each tenant has its own DB), so it does not live in a
// tenant DB. The Postgres impl is for dev; production repoints to a real
// control-plane registry. Fail-closed: an unmapped tenant id → null.
export interface TenantDirectory {
  resolveByEntraTenantId(entraTenantId: string): Promise<TenantId | null>;
}

// Per-tenant operational settings (2.7 + P4) — the READ shape. NULL cap → fall
// back to the env default in the consumer (the web spend guard); unset row →
// every field null. `configCartridgeId` is the tenant's selected config cartridge
// id (P4), OPAQUE to the engine; NULL → none selected (the web uses the
// env/baseline default).
export interface TenantSettings {
  readonly dailyQueryCapUser: number | null;
  readonly dailyQueryCapTenant: number | null;
  readonly configCartridgeId: string | null;
  // Per-tenant model/provider choice (local "Model & keys" settings). All four
  // are OPAQUE to the engine — stored + returned verbatim, never interpreted or
  // decrypted (the web maps the choice → provider env and holds the AES key that
  // decrypts the ciphertext fields). NULL → not set (the web uses the env default).
  readonly modelProvider: string | null;
  readonly ollamaModel: string | null;
  // AES-256-GCM ciphertext (base64) of the user's OWN provider key, or NULL.
  readonly anthropicApiKeyEncrypted: string | null;
  readonly openaiApiKeyEncrypted: string | null;
}

// The WRITE shape for upsertTenantSettings — every data field OPTIONAL so callers
// update INDEPENDENTLY without clobbering each other (the admin caps screen sets
// the caps; the onboarding screen sets the cartridge). Semantics: a field left
// `undefined` is UNCHANGED on update; an explicit value (including `null`) is
// written; an omitted field defaults to NULL on first insert.
export interface TenantSettingsUpdate {
  readonly dailyQueryCapUser?: number | null;
  readonly dailyQueryCapTenant?: number | null;
  readonly configCartridgeId?: string | null;
  // Opaque model/provider choice + encrypted keys. Independent of the caps and
  // cartridge fields — the "Model & keys" screen writes only these, leaving the
  // others untouched (and vice-versa). Pass an explicit `null` to clear a field.
  readonly modelProvider?: string | null;
  readonly ollamaModel?: string | null;
  readonly anthropicApiKeyEncrypted?: string | null;
  readonly openaiApiKeyEncrypted?: string | null;
}

// An app_role → configuration-role binding to create. subjectKind is fixed to
// 'app_role' for the admin surface — the only subject kind resolution consults
// today (group subjects are B2). `scopeOrgUnitId` optionally scopes the binding
// to an org unit: omitted/null → unscoped (granted unconditionally, the flat
// pilot path); set → granted only to users assigned within that unit's subtree
// (departmental access, B1). The engine stores it opaquely; the web resolver
// interprets the scope.
export interface NewRoleBinding {
  readonly subjectKind: 'app_role';
  readonly subjectId: string;
  readonly roleName: string;
  readonly scopeOrgUnitId?: string | null;
}

// Arguments to persist a per-tenant configuration overlay (F20). The `base`
// configuration is passed in so the store can dry-run `composeConfiguration`
// before persisting (validate-on-write, Decision 7) without itself resolving any
// configuration package — the engine stays free of package resolution.
export interface ConfigOverlayUpsert {
  readonly overlay: Overlay;
  readonly base: Configuration;
  readonly updatedBy: string;
}

// Thrown by `upsertConfigOverlay` when the overlay is structurally malformed or
// does not compose against the supplied base (e.g. a non-extension change).
// Nothing is persisted when this throws.
export class InvalidOverlayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidOverlayError';
  }
}

// Per-tenant operational-metadata reads + writes. Every method is tenant-scoped;
// a tenant can only read/write its own rows (enforced by the tenant_id filter).
// This is operational metadata — NOT content, NOT access-tag-gated (like the
// reads and `findRecentQueryEvents` telemetry). The web admin gate decides WHO
// may call the writers; the tenant_id scoping means a gating bug still can't
// cross tenants.
export interface TenancyStore {
  listRoleBindings(tenantId: TenantId): Promise<readonly GroupRoleBinding[]>;
  listOrgUnits(tenantId: TenantId): Promise<readonly OrgUnit[]>;
  listUserUnitAssignments(
    tenantId: TenantId,
    actorOid: string,
  ): Promise<readonly UserUnitAssignment[]>;

  // Writers (2.7). Tenant-scoped operational metadata.
  // Idempotent: revives a soft-deleted match or inserts; a live duplicate is a
  // no-op. Uniqueness is per (subject, role) AND scope — two partial unique
  // indexes: one live unscoped binding per (subject, role), and one live scoped
  // binding per (subject, role, scope). (Postgres treats NULLs as distinct, so a
  // single index including the nullable scope would NOT enforce the unscoped
  // case — hence the split.)
  upsertRoleBinding(tenantId: TenantId, binding: NewRoleBinding): Promise<void>;
  // Soft-deletes the live binding matching (subjectKind, subjectId, roleName,
  // scopeOrgUnitId) — the scope is part of the match key so a scoped and an
  // unscoped binding for the same (subject, role) are removed independently.
  // Absent → no-op.
  removeRoleBinding(tenantId: TenantId, binding: NewRoleBinding): Promise<void>;

  // Org-unit tree writers (B1). Idempotent by the caller-supplied id: upsert
  // updates in place (and revives a soft-deleted unit), else inserts. remove
  // soft-deletes by id; absent → no-op. All tenant-scoped.
  upsertOrgUnit(tenantId: TenantId, unit: NewOrgUnit): Promise<void>;
  removeOrgUnit(tenantId: TenantId, id: string): Promise<void>;

  // User→org-unit assignment writers (B1). Idempotent by the natural key
  // (tenant, actorOid, orgUnitId); roleName is updatable metadata. remove
  // soft-deletes by that key; absent → no-op.
  upsertUserUnitAssignment(tenantId: TenantId, assignment: NewUserUnitAssignment): Promise<void>;
  removeUserUnitAssignment(
    tenantId: TenantId,
    key: { readonly actorOid: string; readonly orgUnitId: string },
  ): Promise<void>;
  // Returns the tenant's settings, or null when no row exists yet.
  getTenantSettings(tenantId: TenantId): Promise<TenantSettings | null>;
  // Upserts the tenant's settings (1:1 row), recording the writing actor. PARTIAL:
  // only the fields present in `settings` are written; an omitted field is left
  // unchanged on update (and NULL on first insert) — so the caps screen and the
  // onboarding (cartridge) screen update their own fields without clobbering.
  upsertTenantSettings(
    tenantId: TenantId,
    settings: TenantSettingsUpdate & { readonly updatedBy: string },
  ): Promise<void>;

  // --- Per-tenant configuration overlay (F20) — opaque operational metadata ---
  // Returns the tenant's stored overlay, or null when none is set (→ the caller
  // uses the base configuration byte-unchanged).
  getConfigOverlay(tenantId: TenantId): Promise<Overlay | null>;
  // Validates the overlay on write (shape + dry-run compose against `base`) and
  // persists it (1:1 row). Throws InvalidOverlayError and persists nothing if
  // the overlay is malformed or does not compose.
  upsertConfigOverlay(tenantId: TenantId, params: ConfigOverlayUpsert): Promise<void>;
  // Removes the tenant's overlay (reverts the tenant to its base configuration);
  // absent → no-op.
  removeConfigOverlay(tenantId: TenantId): Promise<void>;
}

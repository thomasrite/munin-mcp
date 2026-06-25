// Postgres implementations of TenantDirectory + TenancyStore.
//
// Every TenancyStore query is filtered by tenant_id; reads exclude soft-deleted
// rows. No access-tag logic here — this store produces the INPUTS to permission
// resolution (which roles/tags a user gets), not graph reads. The 2.7 writers
// (role bindings, tenant settings) are likewise tenant-scoped operational
// metadata; the web admin gate decides who may call them.

import { composeConfiguration } from '@muninhq/shared';
import type { Overlay } from '@muninhq/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  groupRoleBindings,
  orgUnits,
  tenantConfigOverlays,
  tenantDirectory,
  tenantSettings,
  userUnitAssignments,
} from '../db/schema';
import { type TenantId, asTenantId } from '../graph/types';
import {
  type ConfigOverlayUpsert,
  type GroupRoleBinding,
  InvalidOverlayError,
  type NewOrgUnit,
  type NewRoleBinding,
  type NewUserUnitAssignment,
  type OrgUnit,
  type TenancyStore,
  type TenantDirectory,
  type TenantSettings,
  type TenantSettingsUpdate,
  type UserUnitAssignment,
} from './types';

type Db = PostgresJsDatabase;

export class PostgresTenantDirectory implements TenantDirectory {
  constructor(private readonly db: Db) {}

  async resolveByEntraTenantId(entraTenantId: string): Promise<TenantId | null> {
    const rows = await this.db
      .select({ tenantId: tenantDirectory.tenantId })
      .from(tenantDirectory)
      .where(
        and(eq(tenantDirectory.entraTenantId, entraTenantId), isNull(tenantDirectory.deletedAt)),
      )
      .limit(1);
    return rows[0] ? asTenantId(rows[0].tenantId) : null;
  }
}

export class PostgresTenancyStore implements TenancyStore {
  constructor(private readonly db: Db) {}

  async listRoleBindings(tenantId: TenantId): Promise<readonly GroupRoleBinding[]> {
    const rows = await this.db
      .select()
      .from(groupRoleBindings)
      .where(and(eq(groupRoleBindings.tenantId, tenantId), isNull(groupRoleBindings.deletedAt)));
    return rows.map((r) => ({
      subjectKind: r.subjectKind,
      subjectId: r.subjectId,
      roleName: r.roleName,
      scopeOrgUnitId: r.scopeOrgUnitId,
    }));
  }

  async listOrgUnits(tenantId: TenantId): Promise<readonly OrgUnit[]> {
    const rows = await this.db
      .select()
      .from(orgUnits)
      .where(and(eq(orgUnits.tenantId, tenantId), isNull(orgUnits.deletedAt)));
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      kind: r.kind,
      label: r.label,
      tags: r.tags,
    }));
  }

  async listUserUnitAssignments(
    tenantId: TenantId,
    actorOid: string,
  ): Promise<readonly UserUnitAssignment[]> {
    const rows = await this.db
      .select()
      .from(userUnitAssignments)
      .where(
        and(
          eq(userUnitAssignments.tenantId, tenantId),
          eq(userUnitAssignments.actorOid, actorOid),
          isNull(userUnitAssignments.deletedAt),
        ),
      );
    return rows.map((r) => ({
      actorOid: r.actorOid,
      orgUnitId: r.orgUnitId,
      roleName: r.roleName,
    }));
  }

  // --- Writers (2.7) — tenant-scoped operational metadata ------------------

  async upsertRoleBinding(tenantId: TenantId, binding: NewRoleBinding): Promise<void> {
    // The scope is part of the match: an unscoped and a scoped binding for the
    // same (subject, role) are independent rows. NULL is matched via IS NULL.
    const scope = binding.scopeOrgUnitId ?? null;
    const match = and(
      eq(groupRoleBindings.tenantId, tenantId),
      eq(groupRoleBindings.subjectKind, binding.subjectKind),
      eq(groupRoleBindings.subjectId, binding.subjectId),
      eq(groupRoleBindings.roleName, binding.roleName),
      scope === null
        ? isNull(groupRoleBindings.scopeOrgUnitId)
        : eq(groupRoleBindings.scopeOrgUnitId, scope),
    );
    // Revive a soft-deleted match if present (keeps the unique index happy).
    const revived = await this.db
      .update(groupRoleBindings)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(match, sql`${groupRoleBindings.deletedAt} IS NOT NULL`))
      .returning({ id: groupRoleBindings.id });
    if (revived.length > 0) return;

    // Insert; if a LIVE duplicate already exists the partial unique index makes
    // this a no-op rather than an error.
    await this.db
      .insert(groupRoleBindings)
      .values({
        tenantId,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
        roleName: binding.roleName,
        scopeOrgUnitId: scope,
      })
      .onConflictDoNothing();
  }

  async removeRoleBinding(tenantId: TenantId, binding: NewRoleBinding): Promise<void> {
    // The scope is part of the match key, so a scoped binding and an unscoped
    // binding for the same (subject, role) are removed independently.
    const scope = binding.scopeOrgUnitId ?? null;
    await this.db
      .update(groupRoleBindings)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(groupRoleBindings.tenantId, tenantId),
          eq(groupRoleBindings.subjectKind, binding.subjectKind),
          eq(groupRoleBindings.subjectId, binding.subjectId),
          eq(groupRoleBindings.roleName, binding.roleName),
          scope === null
            ? isNull(groupRoleBindings.scopeOrgUnitId)
            : eq(groupRoleBindings.scopeOrgUnitId, scope),
          isNull(groupRoleBindings.deletedAt),
        ),
      );
  }

  // --- Org-unit tree writers (B1) — generic operational metadata -----------

  async upsertOrgUnit(tenantId: TenantId, unit: NewOrgUnit): Promise<void> {
    // Update-in-place by the caller-supplied id (revive if soft-deleted), else
    // insert. Both reads/writes are tenant-scoped; an id owned by another tenant
    // is not matched here, and an insert with that id would surface a PK error
    // loudly rather than silently crossing tenants.
    const existing = await this.db
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(and(eq(orgUnits.id, unit.id), eq(orgUnits.tenantId, tenantId)))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(orgUnits)
        .set({
          parentId: unit.parentId,
          kind: unit.kind,
          label: unit.label,
          tags: [...unit.tags],
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(orgUnits.id, unit.id), eq(orgUnits.tenantId, tenantId)));
      return;
    }

    await this.db.insert(orgUnits).values({
      id: unit.id,
      tenantId,
      parentId: unit.parentId,
      kind: unit.kind,
      label: unit.label,
      tags: [...unit.tags],
    });
  }

  async removeOrgUnit(tenantId: TenantId, id: string): Promise<void> {
    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.tenantId, tenantId), isNull(orgUnits.deletedAt)));
  }

  // --- User→org-unit assignment writers (B1) -------------------------------

  async upsertUserUnitAssignment(
    tenantId: TenantId,
    assignment: NewUserUnitAssignment,
  ): Promise<void> {
    // Idempotent by the natural key (tenant, actorOid, orgUnitId). roleName is
    // updatable metadata: update it on a live match; revive + set it on a
    // soft-deleted match; else insert.
    const roleName = assignment.roleName ?? null;
    const keyMatch = and(
      eq(userUnitAssignments.tenantId, tenantId),
      eq(userUnitAssignments.actorOid, assignment.actorOid),
      eq(userUnitAssignments.orgUnitId, assignment.orgUnitId),
    );

    const updatedLive = await this.db
      .update(userUnitAssignments)
      .set({ roleName, updatedAt: new Date() })
      .where(and(keyMatch, isNull(userUnitAssignments.deletedAt)))
      .returning({ id: userUnitAssignments.id });
    if (updatedLive.length > 0) return;

    const revived = await this.db
      .update(userUnitAssignments)
      .set({ roleName, deletedAt: null, updatedAt: new Date() })
      .where(and(keyMatch, sql`${userUnitAssignments.deletedAt} IS NOT NULL`))
      .returning({ id: userUnitAssignments.id });
    if (revived.length > 0) return;

    await this.db
      .insert(userUnitAssignments)
      .values({
        tenantId,
        actorOid: assignment.actorOid,
        orgUnitId: assignment.orgUnitId,
        roleName,
      })
      .onConflictDoNothing();
  }

  async removeUserUnitAssignment(
    tenantId: TenantId,
    key: { readonly actorOid: string; readonly orgUnitId: string },
  ): Promise<void> {
    await this.db
      .update(userUnitAssignments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(userUnitAssignments.tenantId, tenantId),
          eq(userUnitAssignments.actorOid, key.actorOid),
          eq(userUnitAssignments.orgUnitId, key.orgUnitId),
          isNull(userUnitAssignments.deletedAt),
        ),
      );
  }

  async getTenantSettings(tenantId: TenantId): Promise<TenantSettings | null> {
    const rows = await this.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      dailyQueryCapUser: row.dailyQueryCapUser,
      dailyQueryCapTenant: row.dailyQueryCapTenant,
      // OPAQUE cartridge id (P4) — returned verbatim, never interpreted.
      configCartridgeId: row.configCartridgeId,
      // OPAQUE model/provider choice + ciphertext keys — returned verbatim, never
      // interpreted or decrypted here (the web owns the meaning + the AES key).
      modelProvider: row.modelProvider,
      ollamaModel: row.ollamaModel,
      anthropicApiKeyEncrypted: row.anthropicApiKeyEncrypted,
      openaiApiKeyEncrypted: row.openaiApiKeyEncrypted,
    };
  }

  async upsertTenantSettings(
    tenantId: TenantId,
    settings: TenantSettingsUpdate & { readonly updatedBy: string },
  ): Promise<void> {
    // PARTIAL update: only the fields PRESENT in `settings` are written on
    // conflict; an omitted (undefined) field is left unchanged — so the caps
    // screen and the onboarding (cartridge) screen each touch only their own
    // fields without clobbering the other. On first insert, an omitted field
    // defaults to NULL (the column default).
    const set: Record<string, unknown> = { updatedBy: settings.updatedBy, updatedAt: new Date() };
    if (settings.dailyQueryCapUser !== undefined)
      set.dailyQueryCapUser = settings.dailyQueryCapUser;
    if (settings.dailyQueryCapTenant !== undefined)
      set.dailyQueryCapTenant = settings.dailyQueryCapTenant;
    if (settings.configCartridgeId !== undefined)
      set.configCartridgeId = settings.configCartridgeId;
    if (settings.modelProvider !== undefined) set.modelProvider = settings.modelProvider;
    if (settings.ollamaModel !== undefined) set.ollamaModel = settings.ollamaModel;
    if (settings.anthropicApiKeyEncrypted !== undefined)
      set.anthropicApiKeyEncrypted = settings.anthropicApiKeyEncrypted;
    if (settings.openaiApiKeyEncrypted !== undefined)
      set.openaiApiKeyEncrypted = settings.openaiApiKeyEncrypted;

    await this.db
      .insert(tenantSettings)
      .values({
        tenantId,
        dailyQueryCapUser: settings.dailyQueryCapUser ?? null,
        dailyQueryCapTenant: settings.dailyQueryCapTenant ?? null,
        configCartridgeId: settings.configCartridgeId ?? null,
        modelProvider: settings.modelProvider ?? null,
        ollamaModel: settings.ollamaModel ?? null,
        anthropicApiKeyEncrypted: settings.anthropicApiKeyEncrypted ?? null,
        openaiApiKeyEncrypted: settings.openaiApiKeyEncrypted ?? null,
        updatedBy: settings.updatedBy,
      })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set });
  }

  // --- Per-tenant configuration overlay (F20) ------------------------------

  async getConfigOverlay(tenantId: TenantId): Promise<Overlay | null> {
    const rows = await this.db
      .select({ overlay: tenantConfigOverlays.overlay })
      .from(tenantConfigOverlays)
      .where(eq(tenantConfigOverlays.tenantId, tenantId))
      .limit(1);
    return rows[0]?.overlay ?? null;
  }

  async upsertConfigOverlay(
    tenantId: TenantId,
    { overlay, base, updatedBy }: ConfigOverlayUpsert,
  ): Promise<void> {
    // A stored overlay is JSON; a function cannot survive serialisation. Reject a
    // function-valued tagExpansion loudly rather than silently dropping it on the
    // round-trip below — the caller must know their input cannot be persisted.
    if (overlay.tagExpansion !== undefined) {
      throw new InvalidOverlayError(
        'overlay.tagExpansion cannot be persisted (a stored overlay is JSON; a function ' +
          'cannot survive serialisation). Supply tag expansion via the base configuration.',
      );
    }
    if (overlay.baseConfigurationId !== base.id) {
      throw new InvalidOverlayError(
        `overlay '${overlay.id}' targets base '${overlay.baseConfigurationId}', ` +
          `but the tenant's base configuration is '${base.id}'`,
      );
    }
    // Round-trip through JSON so we validate (and persist) the EXACT bytes that
    // will later be loaded — any remaining non-serialisable artefact is normalised
    // here, so the dry-run below reflects exactly what is stored.
    // reason: the stored shape is canonical JSON; the cast re-narrows the parsed
    // value to Overlay after the round-trip.
    const persisted = JSON.parse(JSON.stringify(overlay)) as Overlay;
    assertOverlayShape(persisted);

    // Validate-on-write (Decision 7): dry-run the composition so a bad overlay
    // can never be persisted and then break the tenant's every config load. The
    // load-time composeConfiguration throw is the backstop, not the only guard.
    try {
      composeConfiguration(base, persisted);
    } catch (err) {
      throw new InvalidOverlayError(
        `overlay '${persisted.id}' is not a valid extension of base configuration ` +
          `'${base.id}': ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    await this.db
      .insert(tenantConfigOverlays)
      .values({
        tenantId,
        overlayId: persisted.id,
        overlayVersion: persisted.version,
        overlay: persisted,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: tenantConfigOverlays.tenantId,
        set: {
          overlayId: persisted.id,
          overlayVersion: persisted.version,
          overlay: persisted,
          updatedBy,
          updatedAt: new Date(),
        },
      });
  }

  async removeConfigOverlay(tenantId: TenantId): Promise<void> {
    await this.db.delete(tenantConfigOverlays).where(eq(tenantConfigOverlays.tenantId, tenantId));
  }
}

// Minimal structural guard for the opaque overlay blob. Deep semantic validation
// (entity-type shapes, extension-only) is done by the dry-run composeConfiguration
// in upsertConfigOverlay; this catches the obviously-malformed before that.
function assertOverlayShape(value: unknown): asserts value is Overlay {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidOverlayError('overlay must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  for (const field of ['id', 'version', 'baseConfigurationId'] as const) {
    const fieldValue = record[field];
    if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
      throw new InvalidOverlayError(`overlay.${field} must be a non-empty string`);
    }
  }
}

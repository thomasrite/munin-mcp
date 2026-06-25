// Integration test for the tenancy (D3) store.
//
// Verifies: the migration applies; TenantDirectory resolves Entra tid → tenant
// (fail-closed on unknown); and — the security-relevant property — every
// TenancyStore read is tenant-scoped so tenant A can never see tenant B's
// bindings / org units / user assignments. Soft-deleted rows are excluded.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Overlay } from '@muninhq/shared';
import { runMigrations } from '../db/migrate';
import {
  groupRoleBindings,
  orgUnits,
  tenantDirectory,
  tenants,
  userUnitAssignments,
} from '../db/schema';
import { asTenantId } from '../graph/types';
import { sampleConfiguration } from '../test-support/sample-configuration';

import { PostgresTenancyStore, PostgresTenantDirectory } from './postgres-tenancy';
import { InvalidOverlayError } from './types';

const TENANT_A = asTenantId('00000000-0000-0000-0000-0000000000a1');
const TENANT_B = asTenantId('00000000-0000-0000-0000-0000000000b2');

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let directory: PostgresTenantDirectory;
let store: PostgresTenancyStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  directory = new PostgresTenantDirectory(db);
  store = new PostgresTenancyStore(db);

  await db.insert(tenants).values([
    { id: TENANT_A, name: 'tenant-a' },
    { id: TENANT_B, name: 'tenant-b' },
  ]);

  await db.insert(tenantDirectory).values([
    { entraTenantId: 'entra-a', tenantId: TENANT_A },
    { entraTenantId: 'entra-b', tenantId: TENANT_B },
    // a soft-deleted mapping must not resolve
    { entraTenantId: 'entra-gone', tenantId: TENANT_A, deletedAt: new Date() },
  ]);

  await db.insert(groupRoleBindings).values([
    { tenantId: TENANT_A, subjectKind: 'app_role', subjectId: 'A-admin', roleName: 'admin' },
    { tenantId: TENANT_B, subjectKind: 'app_role', subjectId: 'B-admin', roleName: 'admin' },
    {
      tenantId: TENANT_A,
      subjectKind: 'app_role',
      subjectId: 'A-old',
      roleName: 'guest',
      deletedAt: new Date(),
    },
  ]);

  const [unitA] = await db
    .insert(orgUnits)
    .values({ tenantId: TENANT_A, kind: 'institution', label: 'A HQ', tags: ['a:root'] })
    .returning({ id: orgUnits.id });
  await db
    .insert(orgUnits)
    .values({ tenantId: TENANT_B, kind: 'institution', label: 'B HQ', tags: ['b:root'] });

  await db.insert(userUnitAssignments).values([
    { tenantId: TENANT_A, actorOid: 'user-a', orgUnitId: unitA!.id, roleName: 'admin' },
    { tenantId: TENANT_B, actorOid: 'user-b', orgUnitId: unitA!.id },
  ]);
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await container?.stop();
});

describe('PostgresTenantDirectory', () => {
  it('resolves a known Entra tenant id to its Munin tenant', async () => {
    expect(await directory.resolveByEntraTenantId('entra-a')).toBe(TENANT_A);
    expect(await directory.resolveByEntraTenantId('entra-b')).toBe(TENANT_B);
  });

  it('fails closed on an unknown or soft-deleted mapping', async () => {
    expect(await directory.resolveByEntraTenantId('entra-unknown')).toBeNull();
    expect(await directory.resolveByEntraTenantId('entra-gone')).toBeNull();
  });
});

describe('PostgresTenancyStore — tenant isolation', () => {
  it('listRoleBindings returns only the tenant own live bindings', async () => {
    const a = await store.listRoleBindings(TENANT_A);
    expect(a.map((b) => b.subjectId)).toEqual(['A-admin']); // not B-admin, not soft-deleted A-old
    const b = await store.listRoleBindings(TENANT_B);
    expect(b.map((x) => x.subjectId)).toEqual(['B-admin']);
  });

  it('listOrgUnits is tenant-scoped', async () => {
    const a = await store.listOrgUnits(TENANT_A);
    expect(a.map((u) => u.label)).toEqual(['A HQ']);
    expect(a[0]?.tags).toEqual(['a:root']);
    const b = await store.listOrgUnits(TENANT_B);
    expect(b.map((u) => u.label)).toEqual(['B HQ']);
  });

  it('listUserUnitAssignments is tenant- and actor-scoped', async () => {
    const a = await store.listUserUnitAssignments(TENANT_A, 'user-a');
    expect(a).toHaveLength(1);
    expect(a[0]?.roleName).toBe('admin');
    // user-b belongs to tenant B; querying under tenant A returns nothing
    expect(await store.listUserUnitAssignments(TENANT_A, 'user-b')).toEqual([]);
  });
});

// 2.7 writers. Uses a dedicated tenant so it never disturbs the exact-array
// read assertions above.
describe('PostgresTenancyStore — writers (tenant isolation + idempotency)', () => {
  const TENANT_C = asTenantId('00000000-0000-0000-0000-0000000000c3');
  const TENANT_D = asTenantId('00000000-0000-0000-0000-0000000000d4');
  // The four opaque model/provider fields default to NULL on every settings row
  // created without them — spread into the full-shape `toEqual` assertions below.
  const MODEL_NULLS = {
    modelProvider: null,
    ollamaModel: null,
    anthropicApiKeyEncrypted: null,
    openaiApiKeyEncrypted: null,
  } as const;
  const appRole = (subjectId: string, roleName: string) =>
    ({ subjectKind: 'app_role', subjectId, roleName }) as const;

  beforeAll(async () => {
    await db.insert(tenants).values([
      { id: TENANT_C, name: 'tenant-c' },
      { id: TENANT_D, name: 'tenant-d' },
    ]);
  });

  it('upsertRoleBinding adds a live binding, is idempotent, and is tenant-scoped', async () => {
    await store.upsertRoleBinding(TENANT_C, appRole('Munin.Admin', 'admin'));
    await store.upsertRoleBinding(TENANT_C, appRole('Munin.Admin', 'admin')); // idempotent
    const c = await store.listRoleBindings(TENANT_C);
    expect(c).toHaveLength(1); // not duplicated
    expect(c[0]).toMatchObject({ subjectId: 'Munin.Admin', roleName: 'admin' });
    // Never leaks into another tenant.
    expect(await store.listRoleBindings(TENANT_D)).toHaveLength(0);
  });

  it('removeRoleBinding soft-deletes only the matching live binding; revive re-adds it', async () => {
    await store.upsertRoleBinding(TENANT_C, appRole('Munin.Member', 'member'));
    await store.removeRoleBinding(TENANT_C, appRole('Munin.Admin', 'admin'));
    const afterRemove = await store.listRoleBindings(TENANT_C);
    expect(afterRemove.map((b) => b.roleName)).toEqual(['member']); // admin removed
    // Re-adding the removed binding revives it (no unique-index violation).
    await store.upsertRoleBinding(TENANT_C, appRole('Munin.Admin', 'admin'));
    const revived = await store.listRoleBindings(TENANT_C);
    expect(revived.map((b) => b.roleName).sort()).toEqual(['admin', 'member']);
  });

  it('removeRoleBinding does not affect an identical binding in another tenant', async () => {
    await store.upsertRoleBinding(TENANT_C, appRole('Shared.Role', 'guest'));
    await store.upsertRoleBinding(TENANT_D, appRole('Shared.Role', 'guest'));
    await store.removeRoleBinding(TENANT_C, appRole('Shared.Role', 'guest'));
    expect((await store.listRoleBindings(TENANT_C)).some((b) => b.roleName === 'guest')).toBe(
      false,
    );
    // TENANT_D's identical binding is untouched.
    expect((await store.listRoleBindings(TENANT_D)).some((b) => b.roleName === 'guest')).toBe(true);
  });

  it('tenant settings: null when unset, upsert + update, tenant-scoped', async () => {
    expect(await store.getTenantSettings(TENANT_C)).toBeNull();
    await store.upsertTenantSettings(TENANT_C, {
      dailyQueryCapUser: 10,
      dailyQueryCapTenant: 100,
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_C)).toEqual({
      dailyQueryCapUser: 10,
      dailyQueryCapTenant: 100,
      // P4: a settings row created without a cartridge defaults it to NULL.
      configCartridgeId: null,
      ...MODEL_NULLS,
    });
    // Upsert updates in place (1:1 row).
    await store.upsertTenantSettings(TENANT_C, {
      dailyQueryCapUser: 5,
      dailyQueryCapTenant: null,
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_C)).toEqual({
      dailyQueryCapUser: 5,
      dailyQueryCapTenant: null,
      configCartridgeId: null,
      ...MODEL_NULLS,
    });
    // Another tenant is unaffected.
    expect(await store.getTenantSettings(TENANT_D)).toBeNull();
  });

  it('config cartridge id (P4): opaque read/write, NULL default, tenant-scoped, partial-update-safe', async () => {
    // Unset → null (the row may not exist yet).
    expect(await store.getTenantSettings(TENANT_D)).toBeNull();

    // Set ONLY the cartridge (no caps) → caps default to NULL, cartridge stored
    // verbatim. The engine never interprets the string.
    await store.upsertTenantSettings(TENANT_D, {
      configCartridgeId: 'mat-hr',
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_D)).toEqual({
      dailyQueryCapUser: null,
      dailyQueryCapTenant: null,
      configCartridgeId: 'mat-hr',
      ...MODEL_NULLS,
    });

    // Now set ONLY the caps → the cartridge MUST be left unchanged (partial
    // update, no clobber): the caps-screen / onboarding-screen independence.
    await store.upsertTenantSettings(TENANT_D, {
      dailyQueryCapUser: 7,
      dailyQueryCapTenant: 70,
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_D)).toEqual({
      dailyQueryCapUser: 7,
      dailyQueryCapTenant: 70,
      configCartridgeId: 'mat-hr', // unchanged by the caps-only write
      ...MODEL_NULLS,
    });

    // Re-selecting updates only the cartridge; the caps survive. Clearing back to
    // null is an explicit write.
    await store.upsertTenantSettings(TENANT_D, {
      configCartridgeId: 'generic-baseline',
      updatedBy: 'oid-admin',
    });
    expect((await store.getTenantSettings(TENANT_D))?.configCartridgeId).toBe('generic-baseline');
    await store.upsertTenantSettings(TENANT_D, {
      configCartridgeId: null,
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_D)).toEqual({
      dailyQueryCapUser: 7,
      dailyQueryCapTenant: 70,
      configCartridgeId: null,
      ...MODEL_NULLS,
    });
  });

  it('model/provider fields: opaque round-trip, partial-update independence, clear-to-null', async () => {
    const TENANT_M = asTenantId('00000000-0000-0000-0000-0000000000ad');
    await db.insert(tenants).values({ id: TENANT_M, name: 'tenant-m' });

    // Write ONLY the model fields (no caps, no cartridge) — they store verbatim,
    // the engine never interprets the choice nor decrypts the ciphertext.
    await store.upsertTenantSettings(TENANT_M, {
      modelProvider: 'anthropic',
      ollamaModel: 'qwen2.5:7b',
      anthropicApiKeyEncrypted: 'BASE64CIPHERTEXT==',
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_M)).toEqual({
      dailyQueryCapUser: null,
      dailyQueryCapTenant: null,
      configCartridgeId: null,
      modelProvider: 'anthropic',
      ollamaModel: 'qwen2.5:7b',
      anthropicApiKeyEncrypted: 'BASE64CIPHERTEXT==',
      openaiApiKeyEncrypted: null,
    });

    // A caps-only write MUST leave every model field untouched (no clobber).
    await store.upsertTenantSettings(TENANT_M, {
      dailyQueryCapUser: 3,
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_M)).toEqual({
      dailyQueryCapUser: 3,
      dailyQueryCapTenant: null,
      configCartridgeId: null,
      modelProvider: 'anthropic',
      ollamaModel: 'qwen2.5:7b',
      anthropicApiKeyEncrypted: 'BASE64CIPHERTEXT==',
      openaiApiKeyEncrypted: null,
    });

    // Switching provider + clearing the old key is an explicit null write; the
    // caps survive (model-only write touches only the model fields).
    await store.upsertTenantSettings(TENANT_M, {
      modelProvider: 'openai',
      anthropicApiKeyEncrypted: null,
      openaiApiKeyEncrypted: 'OPENAICIPHER==',
      updatedBy: 'oid-admin',
    });
    expect(await store.getTenantSettings(TENANT_M)).toEqual({
      dailyQueryCapUser: 3,
      dailyQueryCapTenant: null,
      configCartridgeId: null,
      modelProvider: 'openai',
      ollamaModel: 'qwen2.5:7b', // unchanged by the provider switch
      anthropicApiKeyEncrypted: null,
      openaiApiKeyEncrypted: 'OPENAICIPHER==',
    });
  });
});

// F20 — per-tenant configuration overlay. Validate-on-write + tenant isolation.
describe('PostgresTenancyStore — config overlay (F20)', () => {
  const TENANT_E = asTenantId('00000000-0000-0000-0000-0000000000e5');
  const TENANT_F = asTenantId('00000000-0000-0000-0000-0000000000f6');
  const base = sampleConfiguration;

  // A valid extension overlay: cosmetic terminology override + one new entity type.
  const validOverlay: Overlay = {
    id: 'ovl-tenant-e',
    version: '1.0.0',
    baseConfigurationId: base.id,
    terminology: { Person: 'Colleague' },
    addEntityTypes: [
      {
        name: 'LocalPolicy',
        description: 'A tenant-local policy document.',
        propertySchema: {
          type: 'object',
          properties: { title: { type: 'string', description: 'Policy title.' } },
          required: ['title'],
        },
        fewShots: [],
      },
    ],
  };

  beforeAll(async () => {
    await db.insert(tenants).values([
      { id: TENANT_E, name: 'tenant-e' },
      { id: TENANT_F, name: 'tenant-f' },
    ]);
  });

  it('returns null when no overlay is set', async () => {
    expect(await store.getConfigOverlay(TENANT_E)).toBeNull();
  });

  it('upserts a valid overlay, round-trips it, updates in place, and is tenant-scoped', async () => {
    await store.upsertConfigOverlay(TENANT_E, {
      overlay: validOverlay,
      base,
      updatedBy: 'oid-admin',
    });
    const got = await store.getConfigOverlay(TENANT_E);
    expect(got?.id).toBe('ovl-tenant-e');
    expect(got?.terminology?.Person).toBe('Colleague');
    expect(got?.addEntityTypes?.[0]?.name).toBe('LocalPolicy');
    // Another tenant never sees it.
    expect(await store.getConfigOverlay(TENANT_F)).toBeNull();

    // Upsert updates in place (1:1 row).
    await store.upsertConfigOverlay(TENANT_E, {
      overlay: { ...validOverlay, version: '1.1.0', terminology: { Person: 'Staff' } },
      base,
      updatedBy: 'oid-admin',
    });
    const updated = await store.getConfigOverlay(TENANT_E);
    expect(updated?.version).toBe('1.1.0');
    expect(updated?.terminology?.Person).toBe('Staff');
  });

  it('rejects a malformed overlay on write and persists nothing', async () => {
    await expect(
      store.upsertConfigOverlay(TENANT_F, {
        // missing id/version/baseConfigurationId
        overlay: { terminology: { Person: 'X' } } as unknown as Overlay,
        base,
        updatedBy: 'oid-admin',
      }),
    ).rejects.toBeInstanceOf(InvalidOverlayError);
    expect(await store.getConfigOverlay(TENANT_F)).toBeNull();
  });

  it('rejects an overlay carrying a function-valued tagExpansion (non-persistable) and persists nothing', async () => {
    await expect(
      store.upsertConfigOverlay(TENANT_F, {
        overlay: {
          id: 'ovl-fn',
          version: '1.0.0',
          baseConfigurationId: base.id,
          tagExpansion: (tags) => tags,
        },
        base,
        updatedBy: 'oid-admin',
      }),
    ).rejects.toBeInstanceOf(InvalidOverlayError);
    expect(await store.getConfigOverlay(TENANT_F)).toBeNull();
  });

  it('rejects an overlay targeting a different base configuration and persists nothing', async () => {
    await expect(
      store.upsertConfigOverlay(TENANT_F, {
        overlay: { ...validOverlay, baseConfigurationId: 'some-other-base' },
        base,
        updatedBy: 'oid-admin',
      }),
    ).rejects.toBeInstanceOf(InvalidOverlayError);
    expect(await store.getConfigOverlay(TENANT_F)).toBeNull();
  });

  it('rejects a non-extension (schema-redefining) overlay on write and persists nothing', async () => {
    const illegal: Overlay = {
      id: 'ovl-bad',
      version: '1.0.0',
      baseConfigurationId: base.id,
      // Re-declaring an existing entity type is a forbidden non-extension change;
      // composeConfiguration throws → upsert must reject (validate-on-write).
      addEntityTypes: [
        {
          name: 'Person',
          description: 'duplicate of an existing type',
          propertySchema: {
            type: 'object',
            properties: { fullName: { type: 'string', description: 'name' } },
            required: [],
          },
          fewShots: [],
        },
      ],
    };
    await expect(
      store.upsertConfigOverlay(TENANT_F, { overlay: illegal, base, updatedBy: 'oid-admin' }),
    ).rejects.toBeInstanceOf(InvalidOverlayError);
    expect(await store.getConfigOverlay(TENANT_F)).toBeNull();
  });

  it('removeConfigOverlay reverts the tenant to base and does not affect another tenant', async () => {
    await store.upsertConfigOverlay(TENANT_F, {
      overlay: { ...validOverlay, id: 'ovl-f', baseConfigurationId: base.id },
      base,
      updatedBy: 'oid-admin',
    });
    expect(await store.getConfigOverlay(TENANT_F)).not.toBeNull();
    await store.removeConfigOverlay(TENANT_F);
    expect(await store.getConfigOverlay(TENANT_F)).toBeNull();
    // TENANT_E's overlay is untouched.
    expect(await store.getConfigOverlay(TENANT_E)).not.toBeNull();
  });
});

// B1 — org-unit + user-unit-assignment writers + scoped role bindings.
// Dedicated tenants so these never disturb the exact-array assertions above.
// Org-unit ids are CALLER-SUPPLIED uuids (the seed wires parentId by id; the
// caller must pick stable ids). All opaque to the engine.
describe('PostgresTenancyStore — org-unit + assignment writers (B1)', () => {
  const TENANT_G = asTenantId('00000000-0000-0000-0000-0000000000a7');
  const TENANT_H = asTenantId('00000000-0000-0000-0000-0000000000a8');
  // Caller-supplied org-unit ids (an org → office → two depts tree).
  const U_ORG = '10000000-0000-0000-0000-000000000001';
  const U_OFFICE = '10000000-0000-0000-0000-000000000002';
  const U_ENGLISH = '10000000-0000-0000-0000-000000000003';
  const U_FINANCE = '10000000-0000-0000-0000-000000000004';

  beforeAll(async () => {
    await db.insert(tenants).values([
      { id: TENANT_G, name: 'tenant-g' },
      { id: TENANT_H, name: 'tenant-h' },
    ]);
  });

  it('upsertOrgUnit inserts a caller-id tree, is idempotent, and is tenant-scoped', async () => {
    await store.upsertOrgUnit(TENANT_G, {
      id: U_ORG,
      parentId: null,
      kind: 'org',
      label: 'Org',
      tags: ['org:g'],
    });
    await store.upsertOrgUnit(TENANT_G, {
      id: U_OFFICE,
      parentId: U_ORG,
      kind: 'office',
      label: 'Office',
      tags: ['office:g'],
    });
    // Re-upsert of the same id is idempotent (update-in-place, not a duplicate).
    await store.upsertOrgUnit(TENANT_G, {
      id: U_OFFICE,
      parentId: U_ORG,
      kind: 'office',
      label: 'Office (renamed)',
      tags: ['office:g'],
    });

    const units = await store.listOrgUnits(TENANT_G);
    expect(units).toHaveLength(2); // not 3 — the re-upsert updated in place
    const office = units.find((u) => u.id === U_OFFICE);
    expect(office).toMatchObject({
      parentId: U_ORG,
      label: 'Office (renamed)',
      tags: ['office:g'],
    });
    // Never leaks into another tenant.
    expect(await store.listOrgUnits(TENANT_H)).toHaveLength(0);
  });

  it('removeOrgUnit soft-deletes by id (revivable); tenant-scoped', async () => {
    await store.upsertOrgUnit(TENANT_G, {
      id: U_ENGLISH,
      parentId: U_OFFICE,
      kind: 'department',
      label: 'English',
      tags: ['dept:english'],
    });
    await store.removeOrgUnit(TENANT_G, U_ENGLISH);
    expect((await store.listOrgUnits(TENANT_G)).some((u) => u.id === U_ENGLISH)).toBe(false);
    // Re-upsert revives the soft-deleted unit (no duplicate id / PK clash).
    await store.upsertOrgUnit(TENANT_G, {
      id: U_ENGLISH,
      parentId: U_OFFICE,
      kind: 'department',
      label: 'English',
      tags: ['dept:english'],
    });
    expect((await store.listOrgUnits(TENANT_G)).some((u) => u.id === U_ENGLISH)).toBe(true);
  });

  it('upsertUserUnitAssignment is idempotent by (tenant,actor,unit); updates roleName; tenant-scoped', async () => {
    // U_FINANCE must exist before assigning to it (FK org_unit_id → org_units).
    await store.upsertOrgUnit(TENANT_G, {
      id: U_FINANCE,
      parentId: U_OFFICE,
      kind: 'department',
      label: 'Finance',
      tags: ['dept:finance'],
    });
    await store.upsertUserUnitAssignment(TENANT_G, { actorOid: 'oid-x', orgUnitId: U_OFFICE });
    // Same natural key → update in place, no duplicate; roleName is updatable.
    await store.upsertUserUnitAssignment(TENANT_G, {
      actorOid: 'oid-x',
      orgUnitId: U_OFFICE,
      roleName: 'lead',
    });
    const got = await store.listUserUnitAssignments(TENANT_G, 'oid-x');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ orgUnitId: U_OFFICE, roleName: 'lead' });
    // A different unit is a distinct assignment.
    await store.upsertUserUnitAssignment(TENANT_G, { actorOid: 'oid-x', orgUnitId: U_FINANCE });
    expect(await store.listUserUnitAssignments(TENANT_G, 'oid-x')).toHaveLength(2);
    // Never leaks into another tenant.
    expect(await store.listUserUnitAssignments(TENANT_H, 'oid-x')).toHaveLength(0);
  });

  it('removeUserUnitAssignment soft-deletes by natural key (revivable)', async () => {
    await store.removeUserUnitAssignment(TENANT_G, { actorOid: 'oid-x', orgUnitId: U_FINANCE });
    const after = await store.listUserUnitAssignments(TENANT_G, 'oid-x');
    expect(after.map((a) => a.orgUnitId)).toEqual([U_OFFICE]); // finance removed
    // Re-upsert revives it (no unique-index clash).
    await store.upsertUserUnitAssignment(TENANT_G, { actorOid: 'oid-x', orgUnitId: U_FINANCE });
    expect(await store.listUserUnitAssignments(TENANT_G, 'oid-x')).toHaveLength(2);
  });
});

// B1 — the NULL-distinct uniqueness trap. The security-relevant regression: the
// two partial unique indexes must allow exactly ONE live unscoped binding per
// (subject,role) AND distinct live bindings per scope — never unlimited dupes.
describe('PostgresTenancyStore — scoped role bindings + NULL-distinct trap (B1)', () => {
  const TENANT_J = asTenantId('00000000-0000-0000-0000-0000000000a9');
  const SCOPE_1 = '20000000-0000-0000-0000-000000000001';
  const SCOPE_2 = '20000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    await db.insert(tenants).values({ id: TENANT_J, name: 'tenant-j' });
    // Scoped bindings FK scope_org_unit_id → org_units; seed the referenced units.
    await store.upsertOrgUnit(TENANT_J, {
      id: SCOPE_1,
      parentId: null,
      kind: 'unit',
      label: 'Scope 1',
      tags: ['s:1'],
    });
    await store.upsertOrgUnit(TENANT_J, {
      id: SCOPE_2,
      parentId: null,
      kind: 'unit',
      label: 'Scope 2',
      tags: ['s:2'],
    });
  });

  it('two unscoped upserts of the same (subject,role) yield exactly ONE live binding (NULL-distinct defeated)', async () => {
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'R',
      roleName: 'r',
    });
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'R',
      roleName: 'r',
    });
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'R',
      roleName: 'r',
      scopeOrgUnitId: null, // explicit null is still unscoped
    });
    const live = (await store.listRoleBindings(TENANT_J)).filter(
      (b) => b.subjectId === 'R' && b.roleName === 'r',
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.scopeOrgUnitId).toBeNull();
  });

  it('the same (subject,role) with two DIFFERENT scopes yields two live bindings; unscoped coexists', async () => {
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'S',
      roleName: 's',
      scopeOrgUnitId: SCOPE_1,
    });
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'S',
      roleName: 's',
      scopeOrgUnitId: SCOPE_2,
    });
    // Idempotent within a scope: re-upserting SCOPE_1 does not duplicate it.
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'S',
      roleName: 's',
      scopeOrgUnitId: SCOPE_1,
    });
    // Plus an unscoped binding for the same (subject,role) — independent row.
    await store.upsertRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'S',
      roleName: 's',
    });

    const live = (await store.listRoleBindings(TENANT_J)).filter(
      (b) => b.subjectId === 'S' && b.roleName === 's',
    );
    expect(live).toHaveLength(3); // scope-1, scope-2, unscoped
    expect(new Set(live.map((b) => b.scopeOrgUnitId))).toEqual(new Set([SCOPE_1, SCOPE_2, null]));
  });

  it('removeRoleBinding matches on scope: removing one scope leaves the other + unscoped intact', async () => {
    await store.removeRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'S',
      roleName: 's',
      scopeOrgUnitId: SCOPE_1,
    });
    const live = (await store.listRoleBindings(TENANT_J)).filter(
      (b) => b.subjectId === 'S' && b.roleName === 's',
    );
    expect(new Set(live.map((b) => b.scopeOrgUnitId))).toEqual(new Set([SCOPE_2, null]));

    // Removing the unscoped one leaves only the scope-2 binding.
    await store.removeRoleBinding(TENANT_J, {
      subjectKind: 'app_role',
      subjectId: 'S',
      roleName: 's',
    });
    const after = (await store.listRoleBindings(TENANT_J)).filter(
      (b) => b.subjectId === 'S' && b.roleName === 's',
    );
    expect(after.map((b) => b.scopeOrgUnitId)).toEqual([SCOPE_2]);
  });
});

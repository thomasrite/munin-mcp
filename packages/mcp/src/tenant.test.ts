// Tenant resolution: env wins; single live tenant discovered; ambiguity and
// emptiness fail fast with actionable messages.

import { describe, expect, it } from 'vitest';

import { resolveTenant } from './tenant';

interface Row {
  id: string;
  name: string;
  deletedAt: Date | null;
}

// Structural stand-in for the Drizzle handle: select().from() resolving rows.
function fakeHandle(rows: Row[]) {
  return {
    db: {
      select: () => ({ from: () => Promise.resolve(rows) }),
    },
  } as never;
}

const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';

describe('resolveTenant', () => {
  it('MUNIN_TENANT_ID wins without touching the database', async () => {
    const handle = { db: undefined } as never; // would throw if consulted
    const resolved = await resolveTenant(handle, { MUNIN_TENANT_ID: T1 });
    expect(resolved).toEqual({ tenantId: T1, source: 'env' });
  });

  it('discovers the single non-deleted tenant', async () => {
    const handle = fakeHandle([
      { id: T1, name: 'one', deletedAt: null },
      { id: T2, name: 'gone', deletedAt: new Date() },
    ]);
    const resolved = await resolveTenant(handle, {});
    expect(resolved).toEqual({ tenantId: T1, source: 'discovered' });
  });

  it('fails fast with the tenant listing when several live tenants exist', async () => {
    const handle = fakeHandle([
      { id: T1, name: 'one', deletedAt: null },
      { id: T2, name: 'two', deletedAt: null },
    ]);
    await expect(resolveTenant(handle, {})).rejects.toThrow(/MUNIN_TENANT_ID/);
    await expect(resolveTenant(handle, {})).rejects.toThrow(new RegExp(T2));
  });

  it('fails fast with seeding guidance when no tenant exists', async () => {
    await expect(resolveTenant(fakeHandle([]), {})).rejects.toThrow(/No tenant found/);
  });
});

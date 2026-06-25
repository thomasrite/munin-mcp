// tenant_config_overlays — per-tenant configuration overlay (F20 / Phase 3).
//
// 1:1 with a tenant (tenant_id is the PK). Holds ONE opaque configuration
// overlay JSON blob per tenant: the engine stores and round-trips it without
// inspecting its fields. The *meaning* of the overlay (which terminology, which
// added entity types) lives entirely in the configuration layer — this table is
// generic operational metadata (no content, no access tags), exactly like
// tenant_settings. The admin gate decides who may write it; the row is
// tenant-scoped by construction.
//
// `overlay_id` / `overlay_version` are denormalised from the JSON so the web's
// per-tenant compose cache can be keyed on them (and for debugging) without
// parsing the blob. The blob itself is the source of truth.
//
// Validation is enforced on WRITE (see PostgresTenancyStore.upsertConfigOverlay):
// a stored overlay is always a valid extension of its base. The load-time
// composeConfiguration throw is the backstop, catching base-config drift.

import type { Overlay } from '@muninhq/shared';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const tenantConfigOverlays = pgTable('tenant_config_overlays', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Denormalised from the blob for cache-key / debug; the blob is authoritative.
  overlayId: text('overlay_id').notNull(),
  overlayVersion: text('overlay_version').notNull(),
  // The opaque overlay document. Typed as Overlay for the store's convenience;
  // the engine never branches on its vertical contents.
  overlay: jsonb('overlay').notNull().$type<Overlay>(),
  // Opaque actor (Entra OID / 'system') who last wrote this overlay.
  updatedBy: text('updated_by').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

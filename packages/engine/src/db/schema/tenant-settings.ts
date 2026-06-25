// tenant_settings — per-tenant operational settings (2.7).
//
// 1:1 with a tenant (tenant_id is the PK). Currently holds the admin-configurable
// daily query SPEND-GUARD caps (D4/F22): NULL means "unset → fall back to the env
// default", so behaviour is unchanged until an admin sets a value. This is
// operational metadata (no content, no access tags); the admin gate decides who
// may write it, the row is tenant-scoped by construction.

import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './_common';
import { tenants } from './tenants';

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Daily per-user / per-tenant query-count caps. NULL → use the env default.
  dailyQueryCapUser: integer('daily_query_cap_user'),
  dailyQueryCapTenant: integer('daily_query_cap_tenant'),
  // The tenant's selected configuration CARTRIDGE id (P4), chosen at onboarding.
  // OPAQUE to the engine: stored + returned verbatim, never interpreted (the web
  // maps it → a config package name via the @muninhq/shared registry). NULL → the
  // tenant has selected nothing; the web falls back to the env/baseline default.
  // A CONFIG choice, NOT permission — it carries no access-tag semantics.
  configCartridgeId: text('config_cartridge_id'),
  // --- Per-tenant model/provider choice (local "Model & keys" settings) -------
  // All four columns are OPAQUE infrastructure config: the engine STORES and
  // RETURNS them verbatim and NEVER interprets, decrypts, or acts on them. The
  // web tier owns the meaning — it maps the choice → provider env, and it holds
  // the AES-256-GCM key (MUNIN_BLOB_ENCRYPTION_KEY) that decrypts the ciphertext
  // columns. Storing only ciphertext here keeps plaintext provider keys out of
  // the engine entirely. NULL on every column → no choice persisted (the web
  // falls back to the run-config/env default). NOT permission, no access-tag
  // semantics. This is the BYO-key-on-a-laptop store; it is used in local mode.
  //
  // The selected LLM/inference provider ('ollama' | 'anthropic' | 'openai').
  modelProvider: text('model_provider'),
  // The chosen Ollama chat model id (e.g. 'qwen2.5:7b'), when modelProvider=ollama.
  ollamaModel: text('ollama_model'),
  // The user's OWN Anthropic API key, AES-256-GCM ciphertext (base64). Never
  // plaintext, never logged; decrypted only in-process by the web at point of use.
  anthropicApiKeyEncrypted: text('anthropic_api_key_encrypted'),
  // The user's OWN OpenAI API key, AES-256-GCM ciphertext (base64). Same contract.
  openaiApiKeyEncrypted: text('openai_api_key_encrypted'),
  // Opaque actor (Entra OID) who last wrote these settings. Named for what it
  // holds — the last writer, updated on every upsert — not "created_by".
  updatedBy: text('updated_by').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

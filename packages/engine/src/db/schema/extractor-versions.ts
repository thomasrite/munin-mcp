// extractor_versions — the registry of (configuration, schema, prompt, model)
// tuples that produced extracted facts. Every entity and edge with
// source_kind='document_extract' references a row here so a fact's
// provenance includes exactly which extractor produced it.
//
// The hashes come from `computeSchemaHash()` in @muninhq/shared. Two distinct
// (schema_hash, prompt_hash, model_id, configuration_id) combinations are
// two distinct rows here. Application code upserts by the natural key.

import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './_common';
import { tenants } from './tenants';

export const extractorVersions = pgTable(
  'extractor_versions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    configurationId: text('configuration_id').notNull(),
    configurationVersion: text('configuration_version').notNull(),
    schemaHash: text('schema_hash').notNull(),
    promptHash: text('prompt_hash').notNull(),
    modelId: text('model_id').notNull(),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('extractor_versions_natural_key').on(
      table.tenantId,
      table.configurationId,
      table.schemaHash,
      table.promptHash,
      table.modelId,
    ),
  ],
);

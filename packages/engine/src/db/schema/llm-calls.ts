// llm_calls — Bedrock cost telemetry per tenant, per purpose.
//
// Every call to a Bedrock model writes a row here. Required for cost
// attribution per customer, for detecting runaway prompt loops, and for
// proving to a DPO that we know exactly what data left the tenant.

import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, llmCallPurpose } from './_common';
import { documents } from './documents';
import { extractorVersions } from './extractor-versions';
import { tenants } from './tenants';

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    // Typed enum so cost-analysis queries are simple equality filters.
    purpose: llmCallPurpose('purpose').notNull(),
    modelId: text('model_id').notNull(),

    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull(),

    // Pence so we can use integer maths without floats. NULL when we don't
    // have a per-token cost model loaded.
    costEstimatePence: bigint('cost_estimate_pence', { mode: 'bigint' }),

    latencyMs: integer('latency_ms').notNull(),
    region: text('region').notNull(),

    extractorVersionId: uuid('extractor_version_id').references(() => extractorVersions.id, {
      onDelete: 'set null',
    }),

    // Optional document context — populated for extraction and embedding
    // calls so per-document cost analysis is a single query.
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

    occurredAt: createdAtColumn(),
  },
  (table) => [
    index('llm_calls_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('llm_calls_purpose_idx').on(table.tenantId, table.purpose, table.occurredAt),
    index('llm_calls_document_idx').on(table.tenantId, table.documentId),
  ],
);

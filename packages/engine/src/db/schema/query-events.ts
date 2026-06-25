// query_events — per-query telemetry (D2). Mirrors llm_calls in spirit.
//
// One row per query answered (web "Ask Munin", the CLI query command, future
// chat/search). Captures WHEN, WHO (actor), latency, outcome (status), and how
// many results — but NEVER the question text or any content/PII. This data
// cannot be retrofitted, so it is written from session one (in the query
// pipeline). Used by the dashboard's recent-activity panel and later ops views.

import { index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './_common';
import { tenants } from './tenants';

// 'error' captures a query that threw (e.g. provider failure) so telemetry is
// complete for every outcome, not just the two success/decline cases.
export const queryEventStatus = pgEnum('query_event_status', ['answered', 'no_evidence', 'error']);

export const queryEvents = pgTable(
  'query_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    // Entra OID, connector name, or 'system'/'cli:query'. NOT access-tag-gated:
    // telemetry carries no content; reads are tenant + actor scoped.
    actor: text('actor').notNull(),
    status: queryEventStatus('status').notNull(),
    // Number of citations the answer carried (0 for no_evidence / error).
    resultCount: integer('result_count').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    // Deliberately no `metadata`/free-text column: this table must never carry
    // the question text or any content/PII (DPO-facing telemetry).
    occurredAt: createdAtColumn(),
  },
  (table) => [
    index('query_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('query_events_tenant_actor_occurred_idx').on(
      table.tenantId,
      table.actor,
      table.occurredAt,
    ),
  ],
);

// Shared column builders used across every domain table.
//
// These helpers exist so the spelling of common columns — access_tags,
// timestamps, soft-delete, creator — is identical everywhere. Each helper
// is a function returning a fresh column definition so it can be called
// inside a `pgTable(...)` declaration without sharing column instances.

import { sql } from 'drizzle-orm';
import { pgEnum, text, timestamp } from 'drizzle-orm/pg-core';

// access_tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[]
export const accessTagsColumn = () =>
  text('access_tags').array().notNull().default(sql`ARRAY[]::text[]`);

export const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAtColumn = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const deletedAtColumn = () => timestamp('deleted_at', { withTimezone: true });

// Opaque actor identifier. Entra ID OID, connector package name, or 'system'.
export const createdByColumn = () => text('created_by').notNull();

// Source kind enum used on entities, edges, and anything else that may carry
// provenance. 'document_extract' rows must also carry a paragraph reference
// and an extractor_version; enforced via CHECK constraint on each table.
export const sourceKind = pgEnum('source_kind', [
  'document_extract',
  'connector',
  'manual',
  'system',
]);

// Embedding target kind. Used on the embeddings table for the polymorphic
// (target_kind, target_id) pair.
export const embeddingTargetKind = pgEnum('embedding_target_kind', ['paragraph', 'entity']);

// LLM call purpose — typed via Postgres enum (migration 0003; 'generation'
// added in 0010) so cost analysis queries are simple equality filters rather
// than free-text matches.
export const llmCallPurpose = pgEnum('llm_call_purpose', [
  'extraction',
  'query',
  'embedding',
  'generation',
  'other',
]);

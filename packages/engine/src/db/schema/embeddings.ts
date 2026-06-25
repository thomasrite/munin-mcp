// embeddings — vector representations for paragraphs and entities.
//
// Polymorphic via (target_kind, target_id). No foreign key on target_id; the
// engine maintains referential integrity at the application layer because
// the target table varies. The vector dimension is 1024 as a Phase 1
// placeholder, to be confirmed in session 1.4 when the embedding model is
// chosen. Regenerating the migration before 1.4 ships is the planned path
// if a different dimension is needed.

import { index, pgTable, text, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core';

import { accessTagsColumn, createdAtColumn, embeddingTargetKind } from './_common';
import { tenants } from './tenants';

export const EMBEDDING_DIMENSIONS = 1024;

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    targetKind: embeddingTargetKind('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),

    modelId: text('model_id').notNull(),
    vector: vector('vector', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),

    // Embeddings carry access_tags too — they're a cache of vectorised text
    // and the same permission semantics apply.
    accessTags: accessTagsColumn(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    // Natural key for upsert by (tenant, target, model). Multiple model
    // versions per target coexist; same (target, model) replaces.
    uniqueIndex('embeddings_natural_key').on(
      table.tenantId,
      table.targetKind,
      table.targetId,
      table.modelId,
    ),
    index('embeddings_tenant_target_idx').on(table.tenantId, table.targetKind, table.targetId),
    index('embeddings_access_tags_gin').using('gin', table.accessTags),
    // HNSW with cosine ops. Parameters left at pgvector defaults for now;
    // we will tune `m` and `ef_construction` in session 1.4 against
    // measured query volume.
    index('embeddings_vector_hnsw').using('hnsw', table.vector.op('vector_cosine_ops')),
  ],
);

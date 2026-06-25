// Integration test for the initial migration.
//
// Spins up a real Postgres+pgvector via testcontainers, runs the migration,
// and verifies:
//   - every expected table and key index exists
//   - the source_kind CHECK constraint fires on the negative case
//   - the internal_bypass_log is architecturally tamper-evident
//     (UPDATE / DELETE / TRUNCATE all fail)

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate';

const EXPECTED_TABLES = [
  'audit_events',
  'citation_events',
  'connector_state',
  'document_duplicates',
  'documents',
  'edges',
  'embeddings',
  'entities',
  'extractor_versions',
  'generation_feedback',
  'group_role_bindings',
  'internal_bypass_log',
  'learned_rules',
  'llm_calls',
  'org_units',
  'paragraphs',
  'query_events',
  'review_queue',
  'style_profiles',
  'tenant_config_overlays',
  'tenant_directory',
  'tenant_settings',
  'tenants',
  'user_unit_assignments',
].sort();

// A subset of indexes whose presence is structurally important. Not every
// index is asserted by name; the architecturally meaningful ones are.
const REQUIRED_INDEXES = [
  // GIN on access_tags — the permission-filter hot path.
  'documents_access_tags_gin',
  'entities_access_tags_gin',
  'edges_access_tags_gin',
  'embeddings_access_tags_gin',
  'paragraphs_access_tags_gin',
  // HNSW on embeddings vector.
  'embeddings_vector_hnsw',
  // Tenant scoping.
  'entities_tenant_type_idx',
  'edges_tenant_type_idx',
  // Soft-delete fast-path partials.
  'entities_not_deleted_idx',
  'documents_not_deleted_idx',
  // The unique natural key on extractor_versions.
  'extractor_versions_natural_key',
  // P3a: version grouping + the document_duplicates natural key.
  'documents_version_group_idx',
  'document_duplicates_natural_key',
  // 0014 (P5 learning loop): per-(tenant, actor) scoping, the rule-embedding
  // HNSW, and the one-profile-per-(tenant, actor, scope) natural key.
  'generation_feedback_tenant_actor_idx',
  'learned_rules_tenant_actor_idx',
  'learned_rules_embedding_hnsw',
  'style_profiles_tenant_actor_scope_key',
];

const EXPECTED_TRIGGERS = [
  'internal_bypass_log_no_update',
  'internal_bypass_log_no_delete',
  'internal_bypass_log_no_truncate',
];

let container: StartedPostgreSqlContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(container.getConnectionUri());
  sql = postgres(container.getConnectionUri(), { max: 1 });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (container) await container.stop();
});

describe('initial migration', () => {
  it('creates every expected table', async () => {
    const rows = await sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%'
    `;
    const tableNames = rows.map((r) => r.tablename).sort();
    expect(tableNames).toEqual(EXPECTED_TABLES);
  });

  it('creates every required index', async () => {
    const rows = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const indexNames = new Set(rows.map((r) => r.indexname));
    for (const required of REQUIRED_INDEXES) {
      expect(indexNames.has(required), `expected index ${required}`).toBe(true);
    }
  });

  it('enables the pgvector extension', async () => {
    const rows = await sql<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates the source_kind and embedding_target_kind enum types', async () => {
    const rows = await sql<Array<{ typname: string }>>`
      SELECT typname FROM pg_type
      WHERE typname IN ('source_kind', 'embedding_target_kind')
    `;
    const names = rows.map((r) => r.typname).sort();
    expect(names).toEqual(['embedding_target_kind', 'source_kind']);
  });

  it('0015: generation_feedback content columns are nullable + content_scrubbed_at exists', async () => {
    const rows = await sql<Array<{ column_name: string; is_nullable: string; data_type: string }>>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_name = 'generation_feedback'
        AND column_name IN ('model_draft', 'human_final', 'content_scrubbed_at')
    `;
    expect(rows).toHaveLength(3);
    // All three nullable: the retention sweep scrubs content IN PLACE (NULLs the
    // draft/final, stamps content_scrubbed_at) — the row skeleton survives.
    for (const r of rows) expect(r.is_nullable, r.column_name).toBe('YES');
    const scrubbedAt = rows.find((r) => r.column_name === 'content_scrubbed_at');
    expect(scrubbedAt?.data_type).toBe('timestamp with time zone');
  });

  it('0011: documents carry the nullable version/validity/sensitivity/simhash columns', async () => {
    const rows = await sql<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'documents'
        AND column_name IN (
          'version_group_id', 'version_seq', 'supersedes_document_id',
          'valid_from', 'valid_to', 'sensitivity_class_id', 'simhash'
        )
    `;
    expect(rows).toHaveLength(7);
    // Every P3a column is nullable — so the migration is non-destructive on
    // existing rows (no backfill required).
    for (const r of rows) expect(r.is_nullable).toBe('YES');
  });
});

describe('provenance CHECK constraint — entities', () => {
  it('accepts a document_extract row with paragraph and extractor_version', async () => {
    const { tenantId, documentId, paragraphId, extractorVersionId } = await seedFixtures();
    const entityId = crypto.randomUUID();
    await sql`
      INSERT INTO entities (
        id, tenant_id, type, properties,
        source_kind, source_document_id, source_paragraph_id, extractor_version_id,
        created_by
      ) VALUES (
        ${entityId}, ${tenantId}, 'Thing', '{}'::jsonb,
        'document_extract', ${documentId}, ${paragraphId}, ${extractorVersionId},
        'test'
      )
    `;
    const rows = await sql`SELECT id FROM entities WHERE id = ${entityId}`;
    expect(rows).toHaveLength(1);
  });

  it('rejects a document_extract row missing source_paragraph_id', async () => {
    const { tenantId, documentId, extractorVersionId } = await seedFixtures();
    await expect(
      sql`
        INSERT INTO entities (
          id, tenant_id, type, properties,
          source_kind, source_document_id, source_paragraph_id, extractor_version_id,
          created_by
        ) VALUES (
          ${crypto.randomUUID()}, ${tenantId}, 'Thing', '{}'::jsonb,
          'document_extract', ${documentId}, NULL, ${extractorVersionId},
          'test'
        )
      `,
    ).rejects.toThrow(/entities_document_extract_requires_provenance/);
  });

  it('rejects a document_extract row missing extractor_version_id', async () => {
    const { tenantId, documentId, paragraphId } = await seedFixtures();
    await expect(
      sql`
        INSERT INTO entities (
          id, tenant_id, type, properties,
          source_kind, source_document_id, source_paragraph_id, extractor_version_id,
          created_by
        ) VALUES (
          ${crypto.randomUUID()}, ${tenantId}, 'Thing', '{}'::jsonb,
          'document_extract', ${documentId}, ${paragraphId}, NULL,
          'test'
        )
      `,
    ).rejects.toThrow(/entities_document_extract_requires_provenance/);
  });

  it('accepts a connector row without paragraph or extractor_version', async () => {
    const { tenantId } = await seedFixtures();
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO entities (
        id, tenant_id, type, properties,
        source_kind, source_connector_package,
        created_by
      ) VALUES (
        ${id}, ${tenantId}, 'Thing', '{}'::jsonb,
        'connector', '@muninhq/connector-test',
        'test'
      )
    `;
    const rows = await sql`SELECT id FROM entities WHERE id = ${id}`;
    expect(rows).toHaveLength(1);
  });
});

describe('internal_bypass_log tamper-evidence', () => {
  it('installs the three immutability triggers', async () => {
    const rows = await sql<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'internal_bypass_log'::regclass AND NOT tgisinternal
    `;
    const triggers = rows.map((r) => r.tgname).sort();
    expect(triggers).toEqual(EXPECTED_TRIGGERS.slice().sort());
  });

  it('rejects UPDATE on internal_bypass_log', async () => {
    const id = await insertBypassRow();
    await expect(
      sql`UPDATE internal_bypass_log SET reason = 'mutated' WHERE id = ${id}`,
    ).rejects.toThrow(/internal_bypass_log is append-only/);
  });

  it('rejects DELETE on internal_bypass_log', async () => {
    const id = await insertBypassRow();
    await expect(sql`DELETE FROM internal_bypass_log WHERE id = ${id}`).rejects.toThrow(
      /internal_bypass_log is append-only/,
    );
  });

  it('rejects TRUNCATE on internal_bypass_log', async () => {
    await insertBypassRow();
    await expect(sql`TRUNCATE TABLE internal_bypass_log`).rejects.toThrow(
      /internal_bypass_log is append-only/,
    );
  });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  tenantId: string;
  documentId: string;
  paragraphId: string;
  extractorVersionId: string;
}

let cachedFixtures: Fixtures | undefined;

async function seedFixtures(): Promise<Fixtures> {
  if (cachedFixtures) return cachedFixtures;

  const tenantId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const paragraphId = crypto.randomUUID();
  const extractorVersionId = crypto.randomUUID();

  await sql`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'fixture')`;
  await sql`
    INSERT INTO documents (id, tenant_id, title, blob_storage_uri, created_by)
    VALUES (${documentId}, ${tenantId}, 'fixture doc', 'blob://fixture', 'test')
  `;
  await sql`
    INSERT INTO paragraphs (id, tenant_id, document_id, paragraph_index, text, created_by)
    VALUES (${paragraphId}, ${tenantId}, ${documentId}, 0, 'fixture text', 'test')
  `;
  await sql`
    INSERT INTO extractor_versions (
      id, tenant_id, configuration_id, configuration_version,
      schema_hash, prompt_hash, model_id
    ) VALUES (
      ${extractorVersionId}, ${tenantId}, 'fixture-config', '0.0.0',
      'sh', 'ph', 'anthropic.claude-sonnet-4-6'
    )
  `;

  cachedFixtures = { tenantId, documentId, paragraphId, extractorVersionId };
  return cachedFixtures;
}

async function insertBypassRow(): Promise<string> {
  const { tenantId } = await seedFixtures();
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO internal_bypass_log (id, tenant_id, call_site, reason)
    VALUES (${id}, ${tenantId}, 'test.call.site', 'forensic test')
  `;
  return id;
}

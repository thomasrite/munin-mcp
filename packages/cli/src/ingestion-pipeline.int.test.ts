// End-to-end ingestion pipeline test.
//
// Postgres + Azurite both via testcontainers. Uses a stub EmbeddingProvider
// so we don't burn API calls per test invocation.

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { filesystemConnector } from '@muninhq/connector-filesystem';

import {
  AzureBlobStorage,
  IngestionPipeline,
  PostgresGraphStore,
  asTenantId,
} from '@muninhq/engine';
import { runMigrations } from '@muninhq/engine/db/migrate';
import { documents, paragraphs, tenants } from '@muninhq/engine/db/schema';

const TENANT = asTenantId('00000000-0000-0000-0000-00000000ab12');
const AZURITE_ACCOUNT = 'devstoreaccount1';
const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

let pg: StartedPostgreSqlContainer;
let azurite: StartedTestContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let store: PostgresGraphStore;
let blob: AzureBlobStorage;
let pipeline: IngestionPipeline;
let fixturesDir: string;

beforeAll(async () => {
  [pg, azurite] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
    new GenericContainer('mcr.microsoft.com/azure-storage/azurite:latest')
      .withExposedPorts(10000)
      .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck'])
      .start(),
  ]);
  await runMigrations(pg.getConnectionUri());
  client = postgres(pg.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  store = new PostgresGraphStore(db);
  const endpoint = `http://${azurite.getHost()}:${azurite.getMappedPort(10000)}/${AZURITE_ACCOUNT}`;
  blob = new AzureBlobStorage({
    authMode: 'devkey',
    endpoint,
    accountName: AZURITE_ACCOUNT,
    accountKey: AZURITE_KEY,
    containerPrefix: 'munin-tenant-',
  });
  pipeline = new IngestionPipeline({
    graphStore: store,
    blobStorage: blob,
    jobConnectionString: pg.getConnectionUri(),
    embeddingModelId: 'test-model',
  });
  await db.insert(tenants).values({ id: TENANT, name: 'pipeline-test' });
  fixturesDir = await makeFixtures();
}, 240_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (pg) await pg.stop();
  if (azurite) await azurite.stop();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE documents, paragraphs, entities, edges, embeddings, audit_events, llm_calls, connector_state, extractor_versions RESTART IDENTITY CASCADE`,
  );
});

async function makeFixtures(): Promise<string> {
  const dir = await mkdir(path.join(os.tmpdir(), `munin-fixtures-${Date.now()}`), {
    recursive: true,
  });
  const root = dir!;
  await writeFile(
    path.join(root, 'plain.txt'),
    'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
  );
  await writeFile(
    path.join(root, 'document.md'),
    '# Heading\n\nIntro under heading.\n\n## Sub\n\nMore detail.\n',
  );
  await writeFile(path.join(root, 'random.heic'), 'unsupported format');
  return root;
}

describe('IngestionPipeline', () => {
  it('ingests txt and md fixtures, skips unsupported, writes document + paragraphs', async () => {
    // Explicitly include .heic in the connector's allowlist so the pipeline
    // sees the file and applies its own "unsupported format" handling.
    const summary = await pipeline.ingest({
      tenantId: TENANT,
      connector: filesystemConnector,
      connectorConfig: {
        rootPath: fixturesDir,
        recursive: false,
        allowedExtensions: ['.txt', '.md', '.heic'],
      },
      accessTags: ['t:public'],
    });
    expect(summary.ingested).toBe(2);
    expect(summary.skippedUnsupported.count).toBe(1);
    expect(summary.failed.count).toBe(0);

    const docs = await db.select().from(documents).where(eq(documents.tenantId, TENANT));
    expect(docs.length).toBe(2);
    expect(docs.every((d) => d.sha256 && d.blobStorageUri)).toBe(true);

    const paras = await db.select().from(paragraphs).where(eq(paragraphs.tenantId, TENANT));
    expect(paras.length).toBeGreaterThan(0);
    // Markdown paragraph should carry headingPath in structure.
    const mdPara = paras.find(
      (p) =>
        String(
          ((p.structure as Record<string, unknown>).headingPath as string[] | undefined)?.[0] ?? '',
        ) === 'Heading',
    );
    expect(mdPara).toBeDefined();
  });

  it('is idempotent: second ingest of the same directory skips already-seen documents', async () => {
    const first = await pipeline.ingest({
      tenantId: TENANT,
      connector: filesystemConnector,
      connectorConfig: { rootPath: fixturesDir, recursive: false },
      accessTags: ['t:public'],
    });
    expect(first.ingested).toBe(2);

    const second = await pipeline.ingest({
      tenantId: TENANT,
      connector: filesystemConnector,
      connectorConfig: { rootPath: fixturesDir, recursive: false },
      accessTags: ['t:public'],
    });
    expect(second.ingested).toBe(0);
    expect(second.skippedAlreadyIngested).toBe(2);

    const docs = await db.select().from(documents).where(eq(documents.tenantId, TENANT));
    expect(docs.length).toBe(2);
  });

  it('--force-reingest creates duplicate documents', async () => {
    await pipeline.ingest({
      tenantId: TENANT,
      connector: filesystemConnector,
      connectorConfig: { rootPath: fixturesDir, recursive: false },
      accessTags: ['t:public'],
    });
    await pipeline.ingest({
      tenantId: TENANT,
      connector: filesystemConnector,
      connectorConfig: { rootPath: fixturesDir, recursive: false },
      accessTags: ['t:public'],
      forceReingest: true,
    });
    const docs = await db.select().from(documents).where(eq(documents.tenantId, TENANT));
    expect(docs.length).toBe(4);
  });

  it('writes raw bytes to blob storage and the URI is fetchable', async () => {
    await pipeline.ingest({
      tenantId: TENANT,
      connector: filesystemConnector,
      connectorConfig: { rootPath: fixturesDir, recursive: false },
      accessTags: ['t:public'],
    });
    const docs = await db.select().from(documents).where(eq(documents.tenantId, TENANT));
    for (const doc of docs) {
      const bytes = await blob.get(doc.blobStorageUri);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });
});

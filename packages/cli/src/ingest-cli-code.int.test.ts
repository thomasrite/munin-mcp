// End-to-end CODE-INGESTION regression test at the CLI / ingest-pipeline level.
//
// WHY THIS EXISTS (F70 #1 regression). The connector's own unit tests asserted
// that `.ts`/`.py` files are selected, yet the real `munin ingest` path could
// still ingest ZERO source files: the connector's default allowlist imports the
// engine's `CODE_FILE_EXTENSIONS`, and if that import ever resolved empty (stale
// build / re-export hazard) the code half silently vanished while the prose
// formats (a local literal) survived — so a connector-only test passed while
// the real path was broken. This test closes that gap by driving the ACTUAL CLI
// core (`runIngest`) — not the connector in isolation — over a fixture dir that
// contains real `.ts` and `.py` files, exactly the way `munin ingest <dir>`
// does (default extensions, `recursive: true`, no explicit allowlist), against
// a real Postgres, and asserting the source files land as documents + paragraphs.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenantId } from '@muninhq/engine';
import { runMigrations } from '@muninhq/engine/db/migrate';
import { documents, paragraphs, tenants } from '@muninhq/engine/db/schema';

import { runIngest } from './ingest-cli';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000c0de0');

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let fixturesDir: string;
let blobRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function clearEnv(key: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  delete process.env[key];
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  await runMigrations(pg.getConnectionUri());
  client = postgres(pg.getConnectionUri(), { max: 5 });
  db = drizzle(client);
  await db.insert(tenants).values({ id: TENANT, name: 'code-ingest-test' });

  blobRoot = await mkdtemp(path.join(os.tmpdir(), 'munin-code-blobs-'));
  fixturesDir = await mkdtemp(path.join(os.tmpdir(), 'munin-code-fixtures-'));
  // A real source tree: TypeScript, Python, and one prose file for contrast.
  await writeFile(
    path.join(fixturesDir, 'app.ts'),
    'export const APP = "munin";\nexport function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
  );
  await writeFile(
    path.join(fixturesDir, 'script.py'),
    'def add(a, b):\n    """Return the sum of a and b."""\n    return a + b\n',
  );
  await writeFile(path.join(fixturesDir, 'README.md'), '# Demo\n\nSome prose for contrast.\n');

  // Configure the CLI core exactly like a local-but-unencrypted dev run, with
  // stub embeddings (no Ollama / no network) so inline embedding succeeds.
  setEnv('GRAPH_STORE', 'postgres');
  setEnv('DATABASE_URL', pg.getConnectionUri());
  setEnv('JOBS', 'inline');
  setEnv('EMBEDDING_PROVIDER', 'stub');
  setEnv('LLM_PROVIDER', 'stub');
  setEnv('BLOB_STORAGE_IMPL', 'filesystem');
  setEnv('BLOB_STORAGE_FS_ROOT', blobRoot);
  // Filesystem blobs without at-rest encryption are allowed outside local mode +
  // non-production; make sure neither flag is set so no encryption key is needed.
  clearEnv('MUNIN_LOCAL_MODE');
}, 240_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (pg) await pg.stop();
  if (fixturesDir) await rm(fixturesDir, { recursive: true, force: true });
  if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('munin ingest <codebase> (CLI core, default extensions)', () => {
  it('ingests real .ts and .py source files — not zero', async () => {
    await runIngest([fixturesDir, '--tenant', TENANT, '--tags', 'personal']);

    const docs = await db.select().from(documents).where(eq(documents.tenantId, TENANT));
    const titles = docs.map((d) => d.title).sort();

    // The exact regression: the source files MUST be ingested, not silently
    // dropped at the connector's file-selection stage.
    expect(titles).toContain('app.ts');
    expect(titles).toContain('script.py');
    // The prose file ingests too — all three reach the store.
    expect(titles).toContain('README.md');
    expect(docs.length).toBe(3);

    // And the code files produced real paragraphs (parsed by the code parser).
    for (const title of ['app.ts', 'script.py']) {
      const doc = docs.find((d) => d.title === title);
      expect(doc, `${title} should be ingested`).toBeDefined();
      if (!doc) continue;
      const paras = await db
        .select()
        .from(paragraphs)
        .where(and(eq(paragraphs.tenantId, TENANT), eq(paragraphs.documentId, doc.id)));
      expect(paras.length, `${title} should have paragraphs`).toBeGreaterThan(0);
    }
  });
});

// Document versioning on re-ingest (P3a) — integration over the real pipeline.
//
// Re-ingesting the same (connector, externalId) with CHANGED content creates a
// new version that supersedes the prior — and the prior version stays LIVE and
// retrievable (never dropped). An exact-byte re-ingest is still skipped.
//
// Runs on PGlite (in-memory) — no Docker, no spend.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BlobStorage } from '../blob';
import type { Connector, ConnectorRecord } from '../connectors';
import { tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import {
  type DocumentId,
  type ReadContext,
  type TenantId,
  asActorId,
  asTenantId,
  internalBypass,
} from '../graph/types';
import type { EmbedEnqueuer } from '../jobs/enqueue';
import { IngestionPipeline } from './ingestion-pipeline';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000ce510');
const TAGS = ['team:hr'];
const EXTERNAL_ID = 'sharepoint:item-42';

class FakeBlob implements BlobStorage {
  private readonly store = new Map<string, Uint8Array>();
  async put(tenantId: TenantId, relativePath: string, bytes: Uint8Array): Promise<string> {
    const uri = `mem://${tenantId}/${relativePath}/${this.store.size}`;
    this.store.set(uri, bytes);
    return uri;
  }
  async get(uri: string): Promise<Uint8Array> {
    const b = this.store.get(uri);
    if (!b) throw new Error(`blob not found: ${uri}`);
    return b;
  }
  async exists(uri: string): Promise<boolean> {
    return this.store.has(uri);
  }
  async delete(uri: string): Promise<void> {
    this.store.delete(uri);
  }
  async ensureTenantContainer(): Promise<void> {}
}

const noopEnqueuer: EmbedEnqueuer = { enqueueAll: async () => {} };

// A connector that always yields ONE document under the SAME externalId, with
// caller-supplied content — so re-ingest exercises the version path.
function sameExternalId(title: string, text: string): Connector {
  return {
    packageName: '@muninhq/connector-test',
    humanName: 'test',
    async *list(): AsyncIterable<ConnectorRecord> {
      yield {
        kind: 'document',
        document: {
          externalId: EXTERNAL_ID,
          title,
          mimeType: 'text/markdown',
          fetchBytes: async () => new TextEncoder().encode(text),
        },
      };
    },
  };
}

let handle: PgliteGraphStoreHandle;
let pipeline: IngestionPipeline;

const bypass: ReadContext = {
  kind: 'bypass',
  tenantId: TENANT,
  bypass: internalBypass('versioning-test', 'read full corpus to assert versioning'),
  actor: asActorId('test'),
};

async function ingest(connector: Connector): Promise<ReturnType<IngestionPipeline['ingest']>> {
  return pipeline.ingest({ tenantId: TENANT, connector, connectorConfig: {}, accessTags: TAGS });
}

async function allDocs() {
  return (await handle.store.findDocuments(bypass, { limit: 100 })).items;
}

beforeAll(async () => {
  handle = await createPgliteGraphStore();
  await handle.db.insert(tenants).values({ id: TENANT, name: 'versioning' });
  pipeline = new IngestionPipeline({
    graphStore: handle.store,
    blobStorage: new FakeBlob(),
    embeddingModelId: 'stub-embed',
    embedEnqueuer: noopEnqueuer,
  });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe('document versioning on re-ingest (P3a)', () => {
  let v1Id: DocumentId;
  let v2Id: DocumentId;

  it('first ingest is a "version of one" (no version metadata)', async () => {
    const res = await ingest(
      sameExternalId('Staff Handbook', 'Version one. The notice period is one month.'),
    );
    expect(res.ingested).toBe(1);
    const docs = await allDocs();
    expect(docs).toHaveLength(1);
    const v1 = docs[0]!;
    v1Id = v1.id;
    expect(v1.versionGroupId).toBeNull();
    expect(v1.versionSeq).toBeNull();
    expect(v1.supersedesDocumentId).toBeNull();
    expect(v1.validTo).toBeNull(); // live
  });

  it('re-ingesting CHANGED content under the same externalId creates a superseding new version', async () => {
    const res = await ingest(
      sameExternalId('Staff Handbook', 'Version two. The notice period is three months now.'),
    );
    expect(res.ingested).toBe(1); // a NEW version, not a skip
    expect(res.skippedAlreadyIngested).toBe(0);

    const docs = await allDocs();
    expect(docs).toHaveLength(2); // BOTH versions present — old not dropped

    const v2 = docs.find((d) => d.id !== v1Id)!;
    v2Id = v2.id;
    // The new version links into the prior's group and supersedes it.
    expect(v2.versionGroupId).toBe(v1Id); // group = first version's id
    expect(v2.versionSeq).toBe(2);
    expect(v2.supersedesDocumentId).toBe(v1Id);
    expect(v2.validFrom).not.toBeNull();
    expect(v2.validTo).toBeNull(); // v2 is now the live one

    // The prior version is marked superseded but STAYS retrievable.
    const v1After = await handle.store.getDocument(bypass, v1Id);
    expect(v1After).not.toBeNull();
    expect(v1After?.validTo).not.toBeNull(); // superseded
  });

  it('findLatestLiveDocumentByExternalId returns the current (v2), not the superseded v1', async () => {
    const live = await handle.store.findLatestLiveDocumentByExternalId(bypass, {
      connectorPackage: '@muninhq/connector-test',
      externalId: EXTERNAL_ID,
    });
    expect(live?.id).toBe(v2Id);
  });

  it('an exact-byte re-ingest of v2 is still skipped (no third version)', async () => {
    const res = await ingest(
      sameExternalId('Staff Handbook', 'Version two. The notice period is three months now.'),
    );
    expect(res.ingested).toBe(0);
    expect(res.skippedAlreadyIngested).toBe(1);
    expect(await allDocs()).toHaveLength(2); // still just v1 + v2
  });
});

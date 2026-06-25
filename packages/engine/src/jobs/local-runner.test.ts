// Unit test for the in-process inline embed runner (P1). Runs against PGlite
// IN-PROCESS — no Docker, no graphile-worker, no network — proving that the
// local runtime can embed paragraphs synchronously behind the EmbedEnqueuer
// seam, exactly as the worker handler would, with no job queue.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import {
  type ReadContext,
  type WriteContext,
  asActorId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import { StubEmbeddingProvider } from '../providers';
import { InlineEmbedRunner } from './local-runner';

const TENANT = asTenantId(crypto.randomUUID());
const ACTOR = asActorId('inline-runner-test');

let handle: PgliteGraphStoreHandle;

beforeAll(async () => {
  handle = await createPgliteGraphStore({}); // in-memory PGlite
  await handle.db.insert(tenants).values({ id: TENANT, name: 'Local' });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe('InlineEmbedRunner (in-process embed; no worker, no Docker)', () => {
  it('embeds paragraphs synchronously in-process so they become searchable', async () => {
    const wctx: WriteContext = { tenantId: TENANT, actor: ACTOR };
    const doc = await handle.store.insertDocument(wctx, {
      title: 'D',
      blobStorageUri: 'file://d',
      accessTags: ['t:ops'],
    });
    const paras = await handle.store.insertParagraphsBulk(wctx, [
      {
        id: asParagraphId(crypto.randomUUID()),
        documentId: doc.id,
        paragraphIndex: 0,
        text: 'inline body',
        accessTags: ['t:ops'],
      },
    ]);
    const para = paras[0];
    if (!para) throw new Error('expected a persisted paragraph');

    const embedding = new StubEmbeddingProvider();
    const runner = new InlineEmbedRunner({
      graphStore: handle.store,
      embeddingProvider: embedding,
    });
    // No worker process — enqueueAll runs the embed work right here, now.
    await runner.enqueueAll([
      { tenantId: TENANT, paragraphIds: [para.id], modelId: embedding.modelId },
    ]);

    const regular: ReadContext = {
      kind: 'regular',
      tenantId: TENANT,
      accessTags: ['t:ops'],
      actor: ACTOR,
    };
    const hits = await handle.store.searchByVector(regular, {
      modelId: embedding.modelId,
      k: 5,
      queryVector: new Array(1024).fill(0.1),
    });
    expect(hits.map((h) => h.targetId)).toContain(para.id);
  });

  it('is a no-op for an empty payload list', async () => {
    const runner = new InlineEmbedRunner({
      graphStore: handle.store,
      embeddingProvider: new StubEmbeddingProvider(),
    });
    await expect(runner.enqueueAll([])).resolves.toBeUndefined();
  });
});

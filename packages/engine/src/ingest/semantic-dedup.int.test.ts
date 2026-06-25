// Semantic-duplicate detection (P3a) — integration over a real store (PGlite).
//
// Two documents whose embedding centroids are cosine ≥ 0.92 get a semantic LINK
// (method='semantic'), and BOTH documents remain fully ingested — link, never
// merge. A clearly-different document is NOT linked.
//
// Embeddings are seeded with CONTROLLED vectors (not a real provider) so the
// cosine geometry is deterministic — this isolates the detector logic from
// embedding quality.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tenants } from '../db/schema';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import {
  type DocumentId,
  type ParagraphId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
  internalBypass,
} from '../graph/types';
import { SemanticDuplicateDetector } from './semantic-dedup';

const TENANT = asTenantId('00000000-0000-0000-0000-00000000d0c0');
const MODEL = 'controlled-1024';
const TAGS = ['team:hr'];
const DIM = 1024;

let handle: PgliteGraphStoreHandle;
let detector: SemanticDuplicateDetector;

const writeCtx: WriteContext = { tenantId: TENANT, actor: asActorId('test') };
const bypass: ReadContext = {
  kind: 'bypass',
  tenantId: TENANT,
  bypass: internalBypass('semantic-dedup-test', 'seed + assert'),
  actor: asActorId('test'),
};

// A unit vector pointing mostly along `axis`, with a little per-paragraph jitter
// so a document's paragraphs are near (but not identical to) each other. Two
// documents built on the SAME axis have near-parallel centroids (cosine ≈ 1);
// different axes are orthogonal (cosine ≈ 0).
function axisVector(axis: number, jitter: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  // small bleed into a neighbour dim so vectors aren't perfectly identical
  v[(axis + 1) % DIM] = jitter;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

async function seedDoc(title: string, axis: number, paragraphCount: number): Promise<DocumentId> {
  const doc = await handle.store.insertDocument(writeCtx, {
    title,
    blobStorageUri: `mem://${title}`,
    accessTags: TAGS,
  });
  const paraParams = Array.from({ length: paragraphCount }, (_v, i) => ({
    documentId: doc.id,
    paragraphIndex: i,
    text: `${title} paragraph ${i}`,
    accessTags: TAGS,
  }));
  const paras = await handle.store.insertParagraphsBulk(writeCtx, paraParams);
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i] as { id: ParagraphId };
    await handle.store.upsertEmbedding(writeCtx, {
      targetKind: 'paragraph',
      targetId: p.id,
      modelId: MODEL,
      vector: axisVector(axis, 0.05 + i * 0.01),
      accessTags: TAGS,
    });
  }
  return doc.id;
}

beforeAll(async () => {
  handle = await createPgliteGraphStore();
  await handle.db.insert(tenants).values({ id: TENANT, name: 'semantic-dedup' });
  detector = new SemanticDuplicateDetector({ reader: handle.store, writer: handle.store });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe('semantic-duplicate detection (P3a)', () => {
  it('links two near-parallel-centroid documents (cosine ≥ 0.92) and keeps both', async () => {
    const docA = await seedDoc('Policy A', 3, 4);
    const docB = await seedDoc('Policy A (reworded)', 3, 4); // same axis → high cosine
    const docC = await seedDoc('Unrelated', 700, 4); // orthogonal axis → low cosine

    const linked = await detector.detectForDocument({
      tenantId: TENANT,
      documentId: docB,
      modelId: MODEL,
    });
    expect(linked).toContain(docA);
    expect(linked).not.toContain(docC);

    // A semantic link is recorded and visible from both endpoints.
    const fromB = await handle.store.findDuplicatesForDocument(bypass, docB);
    expect(fromB.some((l) => l.method === 'semantic')).toBe(true);
    expect(fromB.find((l) => l.method === 'semantic')?.score).toBeGreaterThanOrEqual(0.92);
    const fromA = await handle.store.findDuplicatesForDocument(bypass, docA);
    expect(fromA.some((l) => l.method === 'semantic')).toBe(true);

    // BOTH documents remain fully ingested (link, never merge).
    expect(await handle.store.getDocument(bypass, docA)).not.toBeNull();
    expect(await handle.store.getDocument(bypass, docB)).not.toBeNull();
    // The unrelated document is NOT linked.
    const fromC = await handle.store.findDuplicatesForDocument(bypass, docC);
    expect(fromC).toEqual([]);
  });

  it('is idempotent — re-running detection does not create a second link', async () => {
    const docA = await seedDoc('Handbook', 11, 3);
    const docB = await seedDoc('Handbook copy', 11, 3);
    await detector.detectForDocument({ tenantId: TENANT, documentId: docB, modelId: MODEL });
    // Running again for the OTHER document records the canonical (min,max) pair —
    // the unique natural key collapses it to a single row.
    await detector.detectForDocument({ tenantId: TENANT, documentId: docA, modelId: MODEL });
    const links = (await handle.store.findDuplicatesForDocument(bypass, docA)).filter(
      (l) => l.method === 'semantic',
    );
    expect(links).toHaveLength(1);
  });
});

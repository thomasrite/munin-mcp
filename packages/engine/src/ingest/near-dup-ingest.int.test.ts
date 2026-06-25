// Near-duplicate linking at ingest (P3a) — integration over the real pipeline.
//
// The two DEFINING invariants of dedup are asserted here:
//   1. A near-duplicate is LINKED, never skipped or merged — BOTH documents are
//      fully ingested and a document_duplicates(method='near') row is recorded.
//   2. The ONLY skip is the exact-byte sha256 idempotency check (unchanged).
//
// Runs on PGlite (real Postgres in WASM, in-memory) — no Docker, no spend. A
// no-op embed enqueuer stands in for the embedding stage (irrelevant to the
// lexical near-dup path).

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

const TENANT = asTenantId('00000000-0000-0000-0000-0000000d0011');
const TAGS = ['team:hr'];

// A document-length synthetic policy (see simhash.test.ts for the rationale that
// full-document fingerprints are stable under light edits — single short
// paragraphs are too sensitive; real documents are multi-paragraph).
const ORIGINAL = `The organisation is committed to providing a safe and supportive working
environment for all employees and to resolving concerns fairly, consistently and without undue
delay. This procedure sets out how a member of staff may raise a formal grievance and how the
organisation will respond. It applies to all employees regardless of length of service.

Where a member of staff raises a concern under the formal grievance procedure, the matter will be
acknowledged in writing within five working days and a meeting arranged to discuss the issue. The
employee should set out the nature of the grievance in writing, giving as much relevant detail as
possible, including dates, the people involved and any steps already taken to resolve the matter
informally.

Both parties may be accompanied by a colleague or a recognised trade union representative at any
formal meeting held under this procedure. The companion may address the meeting and confer with the
employee but may not answer questions on the employee's behalf. Reasonable notice of the meeting
will be given so that the employee can arrange to be accompanied.

The outcome of the grievance meeting will be confirmed in writing, together with the reasons for the
decision and details of the right to appeal within ten working days. An appeal will, wherever
possible, be heard by a manager who has not previously been involved, and the decision reached at
the appeal stage will be final.`;
const LIGHT_EDIT = ORIGINAL.replace('within five working days', 'within seven working days');
const UNRELATED = `Annual leave accrues at a rate of two and a half days per completed calendar
month of continuous service, up to the contractual maximum set out in the employee's statement of
particulars. The leave year runs from the first of September to the thirty-first of August.

Requests for leave must be submitted through the staff portal at least two weeks in advance and are
subject to approval by the line manager, taking account of operational needs and the leave already
booked by other team members during the requested period. Approval will not be unreasonably
withheld, but the organisation reserves the right to decline a request where business needs require.

Untaken leave may not normally be carried over into the following leave year. In exceptional
circumstances, and with the prior written agreement of the head of department, up to five days may
be carried forward and must then be taken within the first three months of the new leave year.`;

class FakeBlob implements BlobStorage {
  private readonly store = new Map<string, Uint8Array>();
  async put(tenantId: TenantId, relativePath: string, bytes: Uint8Array): Promise<string> {
    const uri = `mem://${tenantId}/${relativePath}`;
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

// Embedding is irrelevant to the lexical near-dup path.
const noopEnqueuer: EmbedEnqueuer = { enqueueAll: async () => {} };

// A one-shot connector that yields a single markdown document.
function singleDoc(externalId: string, title: string, text: string): Connector {
  return {
    packageName: '@muninhq/connector-test',
    humanName: 'test',
    async *list(): AsyncIterable<ConnectorRecord> {
      yield {
        kind: 'document',
        document: {
          externalId,
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
  bypass: internalBypass('near-dup-test', 'read full corpus to assert dedup behaviour'),
  actor: asActorId('test'),
};

async function ingest(connector: Connector): Promise<ReturnType<IngestionPipeline['ingest']>> {
  return pipeline.ingest({
    tenantId: TENANT,
    connector,
    connectorConfig: {},
    accessTags: TAGS,
  });
}

async function docIdByTitle(title: string): Promise<DocumentId> {
  const page = await handle.store.findDocuments(bypass, { limit: 100 });
  const doc = page.items.find((d) => d.title === title);
  if (!doc) throw new Error(`document ${title} not found`);
  return doc.id;
}

beforeAll(async () => {
  handle = await createPgliteGraphStore();
  await handle.db.insert(tenants).values({ id: TENANT, name: 'near-dup' });
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

describe('near-duplicate linking at ingest (P3a)', () => {
  it('a lightly-edited copy is LINKED (method=near) and BOTH documents remain', async () => {
    const first = await ingest(singleDoc('orig.md', 'Grievance Policy', ORIGINAL));
    expect(first.ingested).toBe(1);
    const second = await ingest(singleDoc('edited.md', 'Grievance Policy (v2)', LIGHT_EDIT));
    // The near-dup is NOT skipped — it is fully ingested.
    expect(second.ingested).toBe(1);
    expect(second.skippedAlreadyIngested).toBe(0);

    // Both documents are present.
    const page = await handle.store.findDocuments(bypass, { limit: 100 });
    const titles = page.items.map((d) => d.title);
    expect(titles).toContain('Grievance Policy');
    expect(titles).toContain('Grievance Policy (v2)');

    // A near-dup link was recorded between them.
    const editedId = await docIdByTitle('Grievance Policy (v2)');
    const links = await handle.store.findDuplicatesForDocument(bypass, editedId);
    expect(links).toHaveLength(1);
    expect(links[0]?.method).toBe('near');
    expect(links[0]?.score).toBeGreaterThan(0.9);
  });

  it('an exact byte-duplicate is SKIPPED by sha256 (the only skip) — no second row', async () => {
    const before = (await handle.store.findDocuments(bypass, { limit: 100 })).total;
    const again = await ingest(
      singleDoc('orig-again.md', 'Grievance Policy (exact copy)', ORIGINAL),
    );
    expect(again.ingested).toBe(0);
    expect(again.skippedAlreadyIngested).toBe(1);
    const after = (await handle.store.findDocuments(bypass, { limit: 100 })).total;
    expect(after).toBe(before); // nothing added
  });

  it('an unrelated document is NOT linked as a near duplicate', async () => {
    const res = await ingest(singleDoc('leave.md', 'Annual Leave Policy', UNRELATED));
    expect(res.ingested).toBe(1);
    const leaveId = await docIdByTitle('Annual Leave Policy');
    const links = await handle.store.findDuplicatesForDocument(bypass, leaveId);
    expect(links).toEqual([]);
  });
});

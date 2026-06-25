// Unit test for the in-process inline extraction runner (F44). Runs against
// PGlite IN-PROCESS — no Docker, no graphile-worker, no network — proving that
// the local runtime can extract paragraphs synchronously through the SAME
// Extractor the worker handler uses, with honest skip/error accounting and no
// job queue.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { tenants } from '../db/schema';
import { EXTRACTION_TOOL_NAME } from '../extract/prompt-assembly';
import { type PgliteGraphStoreHandle, createPgliteGraphStore } from '../graph/pglite-graph-store';
import {
  type DocumentId,
  type ParagraphId,
  type ReadContext,
  type WriteContext,
  asActorId,
  asTenantId,
  newParagraphId,
} from '../graph/types';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallContext,
  ProviderCapabilities,
} from '../providers';
import { sampleConfiguration } from '../test-support/sample-configuration';
import { InlineExtractRunner } from './local-extract-runner';

const TENANT = asTenantId(crypto.randomUUID());
const ACTOR = asActorId('inline-extract-test');
const TAGS = ['t:ops'];

let handle: PgliteGraphStoreHandle;
let docId: DocumentId;

const wctx: WriteContext = { tenantId: TENANT, actor: ACTOR };
const rctx: ReadContext = { kind: 'regular', tenantId: TENANT, accessTags: TAGS, actor: ACTOR };

beforeAll(async () => {
  handle = await createPgliteGraphStore({}); // in-memory PGlite
  await handle.db.insert(tenants).values({ id: TENANT, name: 'Local' });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await handle.db.execute(
    sql`TRUNCATE entities, edges, paragraphs, documents, llm_calls, extractor_versions, audit_events RESTART IDENTITY CASCADE`,
  );
  const doc = await handle.store.insertDocument(wctx, {
    title: 'fixture.txt',
    blobStorageUri: 'mem://fixture',
    accessTags: TAGS,
  });
  docId = doc.id;
});

async function insertParagraph(text: string, index = 0): Promise<ParagraphId> {
  const id = newParagraphId();
  await handle.store.insertParagraphsBulk(wctx, [
    { id, documentId: docId, paragraphIndex: index, text, accessTags: TAGS },
  ]);
  return id;
}

// ---------------------------------------------------------------------------
// Scripted LLM provider — canned responses in call order. A planned 'throw'
// simulates a hard provider failure (timeout, refused connection).
// ---------------------------------------------------------------------------

type Planned =
  | { readonly kind: 'tool'; readonly input: Record<string, unknown> }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'throw'; readonly message: string };

class ScriptedLlmProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 200_000,
    maxBatchSize: 1,
  };
  readonly defaultModel = 'scripted-model';
  callCount = 0;

  constructor(private readonly plan: readonly Planned[]) {}

  async complete(_request: LLMRequest, _ctx: ProviderCallContext): Promise<LLMResponse> {
    const planned = this.plan[this.callCount] ?? { kind: 'text' as const, text: '' };
    this.callCount++;
    if (planned.kind === 'throw') throw new Error(planned.message);
    return {
      text: planned.kind === 'text' ? planned.text : '',
      toolCalls:
        planned.kind === 'tool'
          ? [{ id: 'tc-0', name: EXTRACTION_TOOL_NAME, input: planned.input }]
          : [],
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      modelId: this.defaultModel,
      stopReason: planned.kind === 'tool' ? 'tool_use' : 'end_turn',
    };
  }
}

const projectAtlas = {
  entities: [{ type: 'Project', properties: { name: 'Atlas' } }],
  relationships: [],
};
const invalidOutput = {
  entities: [{ type: 'NotARealType', properties: { foo: 'bar' } }],
  relationships: [],
};

function makeRunner(llm: LLMProvider): InlineExtractRunner {
  return new InlineExtractRunner({
    graphStore: handle.store,
    llmProvider: llm,
    configuration: sampleConfiguration,
  });
}

describe('InlineExtractRunner (in-process extract; no worker, no Docker)', () => {
  it('extracts a happy batch and the entities are visible to a permissioned read', async () => {
    const p1 = await insertParagraph('The Atlas project kicked off in March.', 0);
    const p2 = await insertParagraph('Atlas is on track.', 1);
    const llm = new ScriptedLlmProvider([
      { kind: 'tool', input: projectAtlas },
      { kind: 'tool', input: projectAtlas },
    ]);

    const summary = await makeRunner(llm).run([{ tenantId: TENANT, paragraphIds: [p1, p2] }]);

    expect(summary).toEqual({
      extracted: 2,
      skipped: 0,
      errors: [],
      entitiesWritten: 2,
      edgesWritten: 0,
      repairsUsed: 0,
      stringifiedArraysParsed: 0,
    });

    // The graph rows exist with document_extract provenance and are visible to
    // a regular (access-tagged) read — no bypass needed to see them.
    const page = await handle.store.findEntities(rctx, { types: ['Project'], limit: 10 });
    expect(page.items.length).toBe(2);
    for (const entity of page.items) {
      expect(entity.provenance.kind).toBe('document_extract');
    }
  });

  it('skips-and-continues on a validation failure (one repair retry, then honest skip)', async () => {
    const p1 = await insertParagraph('Unparseable paragraph.', 0);
    const p2 = await insertParagraph('The Atlas project.', 1);
    const llm = new ScriptedLlmProvider([
      { kind: 'tool', input: invalidOutput }, // p1 first attempt
      { kind: 'tool', input: invalidOutput }, // p1 repair — still invalid → skip
      { kind: 'tool', input: projectAtlas }, // p2 proceeds normally
    ]);

    const summary = await makeRunner(llm).run([{ tenantId: TENANT, paragraphIds: [p1, p2] }]);

    expect(summary.extracted).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(summary.repairsUsed).toBe(1);
    expect(llm.callCount).toBe(3);
  });

  it('collects hard errors per paragraph and continues — no throw, no infinite retry', async () => {
    const p1 = await insertParagraph('Provider dies on this one.', 0);
    const p2 = await insertParagraph('The Atlas project.', 1);
    const llm = new ScriptedLlmProvider([
      { kind: 'throw', message: 'connection refused' }, // p1 hard failure
      { kind: 'tool', input: projectAtlas }, // p2 still runs
    ]);

    const summary = await makeRunner(llm).run([{ tenantId: TENANT, paragraphIds: [p1, p2] }]);

    expect(summary.extracted).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([{ paragraphId: p1, message: 'connection refused' }]);
    // Exactly one attempt for the failed paragraph — errors are collected,
    // never retried (there is no graphile to retry for us).
    expect(llm.callCount).toBe(2);
  });

  it('threads the F63 shim counter: stringified array arguments are parsed, extracted, and counted', async () => {
    const p1 = await insertParagraph('The Atlas project, but the model stringifies arrays.', 0);
    // The llama-family defect from the F44 measurement: right entities,
    // JSON-encoded strings where the tool schema declares arrays.
    const llm = new ScriptedLlmProvider([
      {
        kind: 'tool',
        input: {
          entities: JSON.stringify(projectAtlas.entities),
          relationships: JSON.stringify(projectAtlas.relationships),
        },
      },
    ]);

    const summary = await makeRunner(llm).run([{ tenantId: TENANT, paragraphIds: [p1] }]);

    expect(summary.extracted).toBe(1);
    expect(summary.entitiesWritten).toBe(1);
    expect(summary.repairsUsed).toBe(0);
    expect(summary.stringifiedArraysParsed).toBe(2);
    // No repair retry was needed — the shim fixed the typing on first attempt.
    expect(llm.callCount).toBe(1);
  });

  it('counts a prose reply (no tool call) as an honest skip', async () => {
    const p1 = await insertParagraph('A local model may answer in prose.', 0);
    const llm = new ScriptedLlmProvider([{ kind: 'text', text: 'There are no entities here.' }]);

    const summary = await makeRunner(llm).run([{ tenantId: TENANT, paragraphIds: [p1] }]);

    expect(summary).toEqual({
      extracted: 0,
      skipped: 1,
      errors: [],
      entitiesWritten: 0,
      edgesWritten: 0,
      repairsUsed: 0,
      stringifiedArraysParsed: 0,
    });
  });

  it('counts an already-extracted paragraph as skipped (retry-idempotent, no duplicates)', async () => {
    const p1 = await insertParagraph('The Atlas project.', 0);
    const llm = new ScriptedLlmProvider([
      { kind: 'tool', input: projectAtlas },
      { kind: 'tool', input: projectAtlas },
    ]);
    const runner = makeRunner(llm);

    const first = await runner.run([{ tenantId: TENANT, paragraphIds: [p1] }]);
    expect(first.extracted).toBe(1);

    const second = await runner.run([{ tenantId: TENANT, paragraphIds: [p1] }]);
    expect(second.extracted).toBe(0);
    expect(second.skipped).toBe(1);
    // The skip happens before the model call — only the first run hit the LLM.
    expect(llm.callCount).toBe(1);

    const page = await handle.store.findEntities(rctx, { types: ['Project'], limit: 10 });
    expect(page.items.length).toBe(1);
  });

  it('is a no-op for an empty batch list', async () => {
    const llm = new ScriptedLlmProvider([]);
    const summary = await makeRunner(llm).run([]);
    expect(summary).toEqual({
      extracted: 0,
      skipped: 0,
      errors: [],
      entitiesWritten: 0,
      edgesWritten: 0,
      repairsUsed: 0,
      stringifiedArraysParsed: 0,
    });
    expect(llm.callCount).toBe(0);
  });
});

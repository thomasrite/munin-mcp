// EXTRACTION_MODEL end-to-end at the extract entry points (DI/construction
// level — no real provider, no database).
//
// Proves the full chain the worker (worker.ts), the extract CLI (extract-cli.ts)
// and the web upload path (upload-processing.ts) all rely on:
//
//   env EXTRACTION_MODEL → resolveExtractionModelId(env) → entry-point `modelId`
//     dep → Extractor → request.model on the LLM call
//
// The two construction primitives below are exactly what those three entry
// points use: the worker handler + web worker-drain go through
// makeExtractParagraphsHandler; the CLI + web inline path go through
// InlineExtractRunner. Covering both covers all entry points.
//
// SET   → that model id reaches the provider request.
// UNSET → request.model is the provider's defaultModel — the fully-local Ollama
//         tier (one model only) is unaffected.

import { describe, expect, it } from 'vitest';

import { resolveExtractionModelId } from '../extract/extraction-model';
import type { GraphStore } from '../graph/graph-store';
import {
  type DocumentId,
  type ExtractorVersion,
  type Paragraph,
  type TenantId,
  asActorId,
  asDocumentId,
  asExtractorVersionId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallContext,
  ProviderCapabilities,
} from '../providers';
import { sampleConfiguration } from '../test-support/sample-configuration';
import { makeExtractParagraphsHandler } from './extract-paragraphs-handler';
import type { ExtractParagraphsPayload } from './job-types';
import { InlineExtractRunner } from './local-extract-runner';

const PROVIDER_DEFAULT_MODEL = 'provider-default-model';
const ACTOR = asActorId('test:extraction-model-knob');

// Records the `model` field of every LLM request. Returns no tool call, so the
// Extractor records a clean 'no-tool-call' outcome and never persists — keeping
// the fake GraphStore down to the three reads the Extractor actually makes.
class RecordingLlmProvider implements LLMProvider {
  readonly id = 'recording';
  readonly capabilities: ProviderCapabilities = {
    promptCaching: true,
    asymmetricEmbeddings: false,
    maxInputTokens: 200_000,
    maxBatchSize: 1,
  };
  readonly defaultModel = PROVIDER_DEFAULT_MODEL;
  readonly modelsRequested: Array<string | undefined> = [];

  async complete(request: LLMRequest, _ctx: ProviderCallContext): Promise<LLMResponse> {
    this.modelsRequested.push(request.model);
    return {
      text: '',
      toolCalls: [],
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      modelId: request.model ?? this.defaultModel,
      stopReason: 'end_turn',
    };
  }
}

function makeParagraph(tenantId: TenantId, documentId: DocumentId): Paragraph {
  return {
    id: asParagraphId('22222222-2222-2222-2222-222222222222'),
    tenantId,
    documentId,
    paragraphIndex: 0,
    page: null,
    text: 'A paragraph whose model selection we are testing.',
    structure: {},
    accessTags: ['t:public'],
    createdBy: ACTOR,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };
}

// Minimal GraphStore: only the three methods Extractor.extractParagraph reaches
// before the (tool-call-free) LLM response short-circuits it.
function makeFakeStore(tenantId: TenantId, paragraph: Paragraph): GraphStore {
  const extractorVersion: ExtractorVersion = {
    id: asExtractorVersionId('33333333-3333-3333-3333-333333333333'),
    tenantId,
    configurationId: sampleConfiguration.id,
    configurationVersion: sampleConfiguration.version,
    schemaHash: 'test-schema-hash',
    promptHash: 'test-prompt-hash',
    modelId: 'recorded-on-the-row-not-asserted-here',
    createdAt: new Date(0),
  };
  return {
    upsertExtractorVersion: async () => extractorVersion,
    getParagraph: async () => paragraph,
    findEntitiesByParagraphIds: async () => [],
  } as unknown as GraphStore;
}

interface Harness {
  readonly tenantId: TenantId;
  readonly paragraph: Paragraph;
  readonly llm: RecordingLlmProvider;
  readonly store: GraphStore;
  readonly modelId: string | undefined;
}

// Mirrors the exact construction the entry points do: resolve EXTRACTION_MODEL
// from env, then conditionally spread it as the `modelId` dep.
function makeHarness(env: NodeJS.ProcessEnv): Harness {
  const tenantId = asTenantId('11111111-1111-1111-1111-111111111111');
  const documentId = asDocumentId('44444444-4444-4444-4444-444444444444');
  const paragraph = makeParagraph(tenantId, documentId);
  return {
    tenantId,
    paragraph,
    llm: new RecordingLlmProvider(),
    store: makeFakeStore(tenantId, paragraph),
    modelId: resolveExtractionModelId(env),
  };
}

describe('EXTRACTION_MODEL reaches the Extractor — makeExtractParagraphsHandler (worker / web drain)', () => {
  it('SET → the configured model id is the request model', async () => {
    const h = makeHarness({ EXTRACTION_MODEL: 'cloud-extract-model' });
    const task = makeExtractParagraphsHandler({
      graphStore: h.store,
      llmProvider: h.llm,
      configuration: sampleConfiguration,
      ...(h.modelId !== undefined ? { modelId: h.modelId } : {}),
    }) as (payload: ExtractParagraphsPayload) => Promise<void>;

    await task({ tenantId: h.tenantId, paragraphIds: [h.paragraph.id] });

    expect(h.llm.modelsRequested).toEqual(['cloud-extract-model']);
  });

  it('UNSET → the provider default is the request model (local path unbroken)', async () => {
    const h = makeHarness({});
    const task = makeExtractParagraphsHandler({
      graphStore: h.store,
      llmProvider: h.llm,
      configuration: sampleConfiguration,
      ...(h.modelId !== undefined ? { modelId: h.modelId } : {}),
    }) as (payload: ExtractParagraphsPayload) => Promise<void>;

    await task({ tenantId: h.tenantId, paragraphIds: [h.paragraph.id] });

    expect(h.modelId).toBeUndefined();
    expect(h.llm.modelsRequested).toEqual([PROVIDER_DEFAULT_MODEL]);
  });
});

describe('EXTRACTION_MODEL reaches the Extractor — InlineExtractRunner (CLI / web inline)', () => {
  it('SET → the configured model id is the request model', async () => {
    const h = makeHarness({ EXTRACTION_MODEL: 'cloud-extract-model' });
    const runner = new InlineExtractRunner({
      graphStore: h.store,
      llmProvider: h.llm,
      configuration: sampleConfiguration,
      ...(h.modelId !== undefined ? { modelId: h.modelId } : {}),
    });

    const summary = await runner.run([{ tenantId: h.tenantId, paragraphIds: [h.paragraph.id] }]);

    expect(summary.errors).toEqual([]);
    expect(h.llm.modelsRequested).toEqual(['cloud-extract-model']);
  });

  it('UNSET → the provider default is the request model (local path unbroken)', async () => {
    const h = makeHarness({});
    const runner = new InlineExtractRunner({
      graphStore: h.store,
      llmProvider: h.llm,
      configuration: sampleConfiguration,
      ...(h.modelId !== undefined ? { modelId: h.modelId } : {}),
    });

    const summary = await runner.run([{ tenantId: h.tenantId, paragraphIds: [h.paragraph.id] }]);

    expect(summary.errors).toEqual([]);
    expect(h.modelId).toBeUndefined();
    expect(h.llm.modelsRequested).toEqual([PROVIDER_DEFAULT_MODEL]);
  });
});

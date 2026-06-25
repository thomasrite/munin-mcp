// F4 cache-safety guard.
//
// The prompt-cache cost-sharing property is safe ONLY while the cacheable
// boundary covers static, configuration-derived bytes — never tenant content.
// The query pipeline must therefore:
//   (1) build a system prompt + tool that contain no tenant paragraph text;
//   (2) place all tenant paragraph snippets in the user message, never in the
//       cacheable system/tools prefix.
// This test asserts both by capturing the exact LLMRequest the pipeline issues.

import { describe, expect, it } from 'vitest';

import type { GraphStore } from '../graph/graph-store';
import {
  type Document,
  type Entity,
  type Paragraph,
  asActorId,
  asDocumentId,
  asEntityId,
  asExtractorVersionId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import { assembleRuleInferencePrompt } from '../learning/rule-inference-prompt';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallContext,
  ProviderCapabilities,
} from '../providers';
import { ANSWER_TOOL_NAME } from './answer-prompt';
import { assembleContradictionPrompt } from './contradiction-prompt';
import { generateDocument } from './generate';
import { GENERATION_TOOL_NAME, assembleGenerationPrompt } from './generation-prompt';
import { QueryPipeline } from './query-pipeline';
import { assembleSectionRelevancePrompt } from './section-relevance-prompt';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const DOC = asDocumentId('00000000-0000-0000-0000-0000000000dd');
const PARA = asParagraphId('00000000-0000-0000-0000-000000000011');
const ACTOR = asActorId('test');

// Distinctive, unmistakably tenant-derived content. If any byte of this leaks
// into the cacheable prefix the guard fails.
const SECRET_TENANT_TEXT = 'CONFIDENTIAL_TENANT_PAYLOAD_marker_9f3a';

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

function paragraph(): Paragraph {
  return {
    id: PARA,
    tenantId: TENANT,
    documentId: DOC,
    paragraphIndex: 0,
    page: 1,
    text: SECRET_TENANT_TEXT,
    structure: {},
    accessTags: ['public'],
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function document(): Document {
  return {
    id: DOC,
    tenantId: TENANT,
    externalId: null,
    connectorPackage: null,
    title: 'Doc',
    mimeType: null,
    byteSize: null,
    sha256: null,
    blobStorageUri: 'blob://x',
    sourceModifiedAt: null,
    versionGroupId: null,
    versionSeq: null,
    supersedesDocumentId: null,
    validFrom: null,
    validTo: null,
    sensitivityClassId: null,
    accessTags: ['public'],
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function entity(): Entity {
  return {
    id: asEntityId('00000000-0000-0000-0000-0000000000ee'),
    tenantId: TENANT,
    type: 'Thing',
    properties: {},
    accessTags: ['public'],
    provenance: {
      kind: 'document_extract',
      documentId: DOC,
      paragraphId: PARA,
      extractorVersionId: asExtractorVersionId('00000000-0000-0000-0000-0000000000ff'),
      confidence: 1,
    },
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

// Minimal fake GraphStore covering only the reader methods the pipeline calls.
// reason: implementing the full GraphStore surface in a unit test is noise;
// we cast a focused partial. Integration coverage uses the real adapter.
function fakeGraphStore(): GraphStore {
  const partial = {
    searchByVector: async () => [
      {
        embeddingId: 'e' as never,
        targetKind: 'paragraph' as const,
        targetId: PARA,
        distance: 0.1,
        accessTags: ['public'],
      },
    ],
    // Keyword path returns nothing here → hybrid falls back to vector-only, so
    // this cache-safety assertion exercises the same prompt path as before.
    searchByKeyword: async () => [],
    getParagraph: async () => paragraph(),
    getParagraphsByIds: async () => [paragraph()],
    findEntitiesByParagraphIds: async () => [entity()],
    getNeighbours: async () => ({ entities: [], edges: [] }),
    getDocument: async () => document(),
    getDocumentsByIds: async () => [document()],
  };
  return partial as unknown as GraphStore;
}

describe('F4 — query cache boundary excludes tenant content', () => {
  it('puts tenant paragraph text in the user message, never the cacheable prefix', async () => {
    let captured: LLMRequest | undefined;
    const llm: LLMProvider = {
      id: 'fake',
      capabilities: CAPS,
      defaultModel: 'claude-opus-4-7',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        captured = req;
        return {
          text: '',
          toolCalls: [
            {
              id: 't1',
              name: ANSWER_TOOL_NAME,
              input: {
                status: 'answered',
                answer: 'ok [1]',
                citations: [{ marker: 1, sourceId: 'P1', quote: SECRET_TENANT_TEXT }],
              },
            },
          ],
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          modelId: 'claude-opus-4-7',
          stopReason: 'tool_use',
        };
      },
    };
    const embedding: EmbeddingProvider = {
      id: 'fake-embed',
      capabilities: CAPS,
      dimensions: 3,
      modelId: 'fake-embed-model',
      async embed(_req: EmbedRequest): Promise<EmbedResponse> {
        return { vectors: [[0.1, 0.2, 0.3]], inputTokens: 1, modelId: 'fake-embed-model' };
      },
    };

    const pipeline = new QueryPipeline({
      graphStore: fakeGraphStore(),
      llmProvider: llm,
      embeddingProvider: embedding,
    });
    const result = await pipeline.answer({
      tenantId: TENANT,
      accessTags: ['public'],
      question: 'q?',
    });

    expect(result.status).toBe('answered');
    expect(captured).toBeDefined();
    const req = captured!;

    // The cacheable prefix is marked.
    expect(req.cacheableSystemPrefix).toBe(true);

    // (1) System prompt and tools contain no tenant content.
    expect(req.system).not.toContain(SECRET_TENANT_TEXT);
    expect(JSON.stringify(req.tools)).not.toContain(SECRET_TENANT_TEXT);

    // (2) Tenant content lives in the user message.
    const userContent = req.messages.map((m) => m.content).join('\n');
    expect(userContent).toContain(SECRET_TENANT_TEXT);

    // (3) Structural guarantee: the LLMMessage type carries no cache-control
    // field, so message content can never be marked cacheable.
    for (const m of req.messages) {
      expect(Object.keys(m).sort()).toEqual(['content', 'role']);
    }
  });

  // M2.1: the GENERATION cacheable-prefix builder is a SECOND cacheable site.
  // Same F4 rule — the system prompt + tool must be static (argument-free) and
  // carry no tenant content; subject/sections/sources ride in the user turn.
  it('generation prompt: the cacheable prefix is static and tenant-free (assembleGenerationPrompt)', () => {
    const a = assembleGenerationPrompt();
    const b = assembleGenerationPrompt();
    // Byte-identical across calls → provably argument-free / no threaded content.
    expect(a.system).toEqual(b.system);
    expect(JSON.stringify(a.tool)).toEqual(JSON.stringify(b.tool));
    // No tenant content of any kind in the cacheable prefix.
    expect(a.system).not.toContain(SECRET_TENANT_TEXT);
    expect(JSON.stringify(a.tool)).not.toContain(SECRET_TENANT_TEXT);
  });

  // Move 1: the SECTION-RELEVANCE routing prompt is a THIRD cacheable site (its
  // call sets cacheableSystemPrefix: true). Same F4 rule — the system prompt +
  // tool must be static (argument-free) and tenant-free; the sources/sections it
  // routes ride in the user turn (renderRelevanceUserMessage), never here.
  it('section-relevance prompt: the cacheable prefix is static and tenant-free (assembleSectionRelevancePrompt)', () => {
    const a = assembleSectionRelevancePrompt();
    const b = assembleSectionRelevancePrompt();
    expect(a.system).toEqual(b.system);
    expect(JSON.stringify(a.tool)).toEqual(JSON.stringify(b.tool));
    expect(a.system).not.toContain(SECRET_TENANT_TEXT);
    expect(JSON.stringify(a.tool)).not.toContain(SECRET_TENANT_TEXT);
  });

  // P3b: the CONTRADICTION-DETECTION prompt is a FOURTH cacheable site (its call
  // sets cacheableSystemPrefix: true). Same F4 rule — the system prompt + tool
  // must be static (argument-free) and tenant-free; the grounded answer + cited
  // source snippets it inspects ride in the user turn (renderContradictionUserMessage),
  // never here.
  it('contradiction prompt: the cacheable prefix is static and tenant-free (assembleContradictionPrompt)', () => {
    const a = assembleContradictionPrompt();
    const b = assembleContradictionPrompt();
    expect(a.system).toEqual(b.system);
    expect(JSON.stringify(a.tool)).toEqual(JSON.stringify(b.tool));
    expect(a.system).not.toContain(SECRET_TENANT_TEXT);
    expect(JSON.stringify(a.tool)).not.toContain(SECRET_TENANT_TEXT);
  });

  // P5a: the RULE-INFERENCE prompt is a FIFTH cacheable site (inferRule sets
  // cacheableSystemPrefix: true). Same F4 rule — the system prompt + tool must be
  // static (argument-free) and tenant-free; the (draft → final) pair it inspects
  // rides in the user turn (renderInferenceUserMessage), never here. (inferRule's
  // own unit test proves the draft/final land in the user message only.)
  it('rule-inference prompt: the cacheable prefix is static and tenant-free (assembleRuleInferencePrompt)', () => {
    const a = assembleRuleInferencePrompt();
    const b = assembleRuleInferencePrompt();
    expect(a.system).toEqual(b.system);
    expect(JSON.stringify(a.tool)).toEqual(JSON.stringify(b.tool));
    expect(a.system).not.toContain(SECRET_TENANT_TEXT);
    expect(JSON.stringify(a.tool)).not.toContain(SECRET_TENANT_TEXT);
  });

  // P5a: an injected learningRules string is TENANT CONTENT. The injection
  // invariant is the cache-safety rule that makes the feature safe — the rule
  // must land in the user MESSAGE (a <learning-rules> block) and be ABSENT from
  // the cacheable system/tool prefix, exactly like the tenant paragraph text. If
  // a rule ever reached the cached prefix it would poison the cross-tenant prompt
  // cache. This captures the real LLMRequest generateDocument issues and asserts
  // both halves.
  it('generation injection: learningRules lands in the user message, never the cacheable prefix', async () => {
    const LEARNING_MARKER = 'LEARNED_RULE_marker_7c2b__prefer_short_sentences';
    let captured: LLMRequest | undefined;
    const llm: LLMProvider = {
      id: 'fake',
      capabilities: CAPS,
      defaultModel: 'claude-sonnet-4-6',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        captured = req;
        return {
          text: '',
          toolCalls: [
            {
              id: 't1',
              name: GENERATION_TOOL_NAME,
              input: {
                status: 'generated',
                sections: [
                  {
                    heading: 'H',
                    // Quote == the paragraph text → the claim grounds, so the
                    // document is 'generated' and the path runs end to end.
                    claims: [
                      { text: 'ok', citations: [{ sourceId: 'P1', quote: SECRET_TENANT_TEXT }] },
                    ],
                  },
                ],
              },
            },
          ],
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          modelId: 'claude-sonnet-4-6',
          stopReason: 'tool_use',
        };
      },
    };
    const ctx: ProviderCallContext = {
      tenantId: TENANT,
      purpose: 'generation',
      graphStore: fakeGraphStore(),
    };

    const result = await generateDocument(llm, ctx, {
      subject: 'Subject',
      sections: [{ heading: 'H', instruction: 'Summarise the records.' }],
      sources: [{ sourceId: 'P1', paragraph: paragraph() }],
      completeness: { mayHaveUnlinkedRecords: false, recordCount: 1 },
      learningRules: LEARNING_MARKER,
    });

    expect(result.status).toBe('generated');
    expect(captured).toBeDefined();
    const req = captured!;

    // The cacheable prefix is marked.
    expect(req.cacheableSystemPrefix).toBe(true);

    // (1) The injected rule is ABSENT from the cacheable system prompt + tools.
    expect(req.system).not.toContain(LEARNING_MARKER);
    expect(JSON.stringify(req.tools)).not.toContain(LEARNING_MARKER);

    // (2) The injected rule rides in the user message.
    const userContent = req.messages.map((m) => m.content).join('\n');
    expect(userContent).toContain(LEARNING_MARKER);

    // (3) Tenant paragraph content is likewise user-message-only (unchanged F4).
    expect(req.system).not.toContain(SECRET_TENANT_TEXT);
    expect(userContent).toContain(SECRET_TENANT_TEXT);
  });
});

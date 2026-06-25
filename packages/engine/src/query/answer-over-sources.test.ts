// answerOverSources (G1 / F31) — unit. The completeness INVARIANT: an
// entity-centric answer is never both incomplete AND unbanned. Uses an in-memory
// LLM + a no-op query_events writer (no DB needed — answerOverSources reads
// nothing; the sources are caller-supplied).

import { describe, expect, it, vi } from 'vitest';

import type { GraphStore } from '../graph/graph-store';
import {
  type ActorId,
  type Paragraph,
  type TenantId,
  asActorId,
  asDocumentId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import type { LLMProvider, LLMRequest, LLMResponse } from '../providers';
import { ANSWER_TOOL_NAME } from './answer-prompt';
import { type AnswerSource, QueryPipeline } from './query-pipeline';

const TENANT: TenantId = asTenantId('00000000-0000-0000-0000-0000000000aa');
const ACTOR: ActorId = asActorId('system:test');

function para(id: string, text: string): Paragraph {
  return {
    id: asParagraphId(id),
    tenantId: TENANT,
    documentId: asDocumentId(`doc-${id}`),
    paragraphIndex: 0,
    page: null,
    text,
    structure: {},
    accessTags: ['t'],
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

// LLM stub: cites the supplied quote against source P1 (so the citation grounds
// and survives resolve()). The quote MUST be a verbatim substring of the source.
function citingLLM(quote: string): LLMProvider {
  return {
    id: 'stub',
    capabilities: {
      promptCaching: false,
      asymmetricEmbeddings: false,
      maxInputTokens: 100000,
      maxBatchSize: 1,
    },
    defaultModel: 'claude-opus-4-7',
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      return {
        text: '',
        toolCalls: [
          {
            id: 't1',
            name: ANSWER_TOOL_NAME,
            input: {
              status: 'answered',
              answer: 'Here is what is on file [1].',
              citations: [{ marker: 1, sourceId: 'P1', quote }],
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
}

// no_evidence LLM (finds nothing to say).
const declineLLM: LLMProvider = {
  id: 'stub',
  capabilities: {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 100000,
    maxBatchSize: 1,
  },
  defaultModel: 'claude-opus-4-7',
  async complete(): Promise<LLMResponse> {
    return {
      text: '',
      toolCalls: [
        {
          id: 't1',
          name: ANSWER_TOOL_NAME,
          input: { status: 'no_evidence', answer: '', citations: [] },
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

// Minimal GraphStore: only insertQueryEvent is exercised (telemetry, no-op).
function stubStore(): GraphStore {
  return { insertQueryEvent: vi.fn(async () => {}) } as unknown as GraphStore;
}

const embedding = {
  id: 'stub-embed',
  modelId: 'stub-embed',
  dimensions: 1,
  capabilities: {
    promptCaching: false,
    asymmetricEmbeddings: false,
    maxInputTokens: 1,
    maxBatchSize: 1,
  },
  async embed() {
    return { vectors: [[0]], modelId: 'stub-embed' };
  },
} as unknown as ConstructorParameters<typeof QueryPipeline>[0]['embeddingProvider'];

function pipeline(llm: LLMProvider): QueryPipeline {
  return new QueryPipeline({
    graphStore: stubStore(),
    llmProvider: llm,
    embeddingProvider: embedding,
  });
}

const SUBJECT_TEXT = 'Helena Voss was absent for 12 working days in February.';
const sources: AnswerSource[] = [
  { paragraph: para('p1', SUBJECT_TEXT), documentTitle: 'absence.md' },
];

describe('answerOverSources — the completeness INVARIANT (never incomplete-and-unbanned)', () => {
  it('an INCOMPLETE gather → answered WITH a specific banner naming the subject', async () => {
    const result = await pipeline(citingLLM(SUBJECT_TEXT)).answerOverSources({
      tenantId: TENANT,
      question: 'Everything about Helena Voss',
      subject: 'Helena Voss',
      sources,
      completeness: { mayHaveUnlinkedRecords: true, recordCount: 1 },
      actor: ACTOR,
    });
    expect(result.status).toBe('answered');
    expect(result.citations).toHaveLength(1); // fail-closed grounding preserved
    // INVARIANT: incomplete ⇒ banner present, specific (names the subject).
    expect(result.completeness).toBeDefined();
    expect(result.completeness?.complete).toBe(false);
    expect(result.completeness?.note).not.toBeNull();
    expect(result.completeness?.note).toContain('Helena Voss');
  });

  it('a COMPLETE gather → answered, complete=true, note=null', async () => {
    const result = await pipeline(citingLLM(SUBJECT_TEXT)).answerOverSources({
      tenantId: TENANT,
      question: 'Everything about Helena Voss',
      subject: 'Helena Voss',
      sources,
      completeness: { mayHaveUnlinkedRecords: false, recordCount: 1 },
      actor: ACTOR,
    });
    expect(result.status).toBe('answered');
    expect(result.completeness?.complete).toBe(true);
    expect(result.completeness?.note).toBeNull();
  });

  it('even a no_evidence entity-centric answer carries the disposition (honest gather report)', async () => {
    const result = await pipeline(declineLLM).answerOverSources({
      tenantId: TENANT,
      question: 'Everything about Helena Voss',
      subject: 'Helena Voss',
      sources,
      completeness: { mayHaveUnlinkedRecords: true, recordCount: 1 },
      actor: ACTOR,
    });
    expect(result.status).toBe('no_evidence');
    // Banded even when empty: we still gathered the subject's records.
    expect(result.completeness).toBeDefined();
    expect(result.completeness?.complete).toBe(false);
  });

  it('fail-closed: a fabricated quote (not in any source) is dropped → no_evidence, still banded', async () => {
    const result = await pipeline(
      citingLLM('a quote that is not in the source at all'),
    ).answerOverSources({
      tenantId: TENANT,
      question: 'Everything about Helena Voss',
      subject: 'Helena Voss',
      sources,
      completeness: { mayHaveUnlinkedRecords: true, recordCount: 1 },
      actor: ACTOR,
    });
    // The ungrounded citation is dropped; an answer with no surviving citation
    // downgrades to no_evidence — and the disposition still rides along.
    expect(result.status).toBe('no_evidence');
    expect(result.completeness?.complete).toBe(false);
  });

  it('no sources at all → no_evidence, still banded (records may be unlinked)', async () => {
    const result = await pipeline(citingLLM(SUBJECT_TEXT)).answerOverSources({
      tenantId: TENANT,
      question: 'Everything about Helena Voss',
      subject: 'Helena Voss',
      sources: [],
      completeness: { mayHaveUnlinkedRecords: true, recordCount: 0 },
      actor: ACTOR,
    });
    expect(result.status).toBe('no_evidence');
    expect(result.completeness).toBeDefined();
  });
});

describe('answerOverSources — the grounding-truncation guard (audit finding #1)', () => {
  // THE CONFIRMED-HIGH DEFECT: a gather can report complete=true while the model
  // was grounded on only the first `maxParagraphs` of N records. Here the gather is
  // complete BY KEY (mayHaveUnlinkedRecords:false, recordCount:20) — yet only 16 of
  // the 20 sources fit the grounding window (maxParagraphs=16). The answer is
  // therefore NOT complete, and the banner must say so (16 of 20) — independently of
  // unlinked records. Pre-fix buildCompleteness returns complete:true here.
  const twenty: AnswerSource[] = Array.from({ length: 20 }, (_, i) => ({
    paragraph: para(`p${i + 1}`, `Record ${i + 1} concerning Helena Voss.`),
    documentTitle: `rec-${i + 1}.md`,
  }));

  it('a key-COMPLETE gather whose grounding window truncated the set → NOT complete, banner names M of N', async () => {
    const result = await new QueryPipeline({
      graphStore: stubStore(),
      llmProvider: citingLLM('Helena Voss'),
      embeddingProvider: embedding,
      maxParagraphs: 16,
    }).answerOverSources({
      tenantId: TENANT,
      question: 'Everything about Helena Voss',
      subject: 'Helena Voss',
      sources: twenty,
      completeness: { mayHaveUnlinkedRecords: false, recordCount: 20 },
      actor: ACTOR,
    });
    expect(result.status).toBe('answered');
    // THE GUARD: complete=false even though no record was unlinked, because the
    // model only saw 16 of the 20 gathered records.
    expect(result.completeness?.complete).toBe(false);
    expect(result.completeness?.note).not.toBeNull();
    expect(result.completeness?.note).toContain('Helena Voss');
    expect(result.completeness?.note).toContain('16'); // admitted to the window
    expect(result.completeness?.note).toContain('20'); // gathered in total
    // recordCount stays the full gathered total — the banner is honest about N.
    expect(result.completeness?.recordCount).toBe(20);
  });
});

// Stub LLM that returns an arbitrary answer string + citations array verbatim, so a
// test can craft the exact (answer, citations) the resolve()/floor path must handle.
function answeringLLM(
  answer: string,
  citations: ReadonlyArray<{ marker: number; sourceId: string; quote: string }>,
): LLMProvider {
  return {
    id: 'stub',
    capabilities: {
      promptCaching: false,
      asymmetricEmbeddings: false,
      maxInputTokens: 100000,
      maxBatchSize: 1,
    },
    defaultModel: 'claude-opus-4-7',
    async complete(): Promise<LLMResponse> {
      return {
        text: '',
        toolCalls: [
          {
            id: 't1',
            name: ANSWER_TOOL_NAME,
            input: { status: 'answered', answer, citations: [...citations] },
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
}

describe('answer floor is claim-level — uncited sentences never reach the user (audit finding #2)', () => {
  // THE DEFECT: the floor only checked that >=1 citation survived. An answer with
  // one cited sentence + one uncited factual sentence passed, and the uncited
  // sentence (an ungrounded assertion) rode out to the user. Mirror the generation
  // path: a sentence carrying no surviving citation marker is dropped.
  const apolloSrc: AnswerSource[] = [
    { paragraph: para('p1', 'Apollo ships in Q3.'), documentTitle: 'roadmap.md' },
    { paragraph: para('p2', 'The board approved the budget.'), documentTitle: 'board.md' },
  ];

  it('leak-closed: an uncited factual sentence is dropped; the cited sentence survives (answered)', async () => {
    const answer =
      'Apollo ships Q3 [1]. The budget was £2m and the director approved it personally.';
    const result = await pipeline(
      answeringLLM(answer, [{ marker: 1, sourceId: 'P1', quote: 'Apollo ships' }]),
    ).answerOverSources({
      tenantId: TENANT,
      question: 'When does Apollo ship?',
      subject: 'Apollo',
      sources: apolloSrc,
      completeness: { mayHaveUnlinkedRecords: false, recordCount: 2 },
      actor: ACTOR,
    });
    expect(result.status).toBe('answered');
    // The cited claim survives intact, with its marker.
    expect(result.answer).toContain('Apollo ships Q3 [1]');
    expect(result.citations).toHaveLength(1);
    // The uncited sentence (no marker) must NOT reach the user.
    expect(result.answer).not.toContain('budget');
    expect(result.answer).not.toContain('director approved');
  });

  it('every sentence uncited (nothing grounds) → no_evidence', async () => {
    const answer = 'The budget was £2m. The director approved it personally.';
    const result = await pipeline(answeringLLM(answer, [])).answerOverSources({
      tenantId: TENANT,
      question: 'What is the budget?',
      subject: 'Apollo',
      sources: apolloSrc,
      completeness: { mayHaveUnlinkedRecords: false, recordCount: 2 },
      actor: ACTOR,
    });
    expect(result.status).toBe('no_evidence');
    expect(result.citations).toHaveLength(0);
  });

  it('no over-trim: a fully-cited multi-sentence answer is returned unchanged', async () => {
    const answer = 'Apollo ships Q3 [1]. The board approved the budget [2].';
    const result = await pipeline(
      answeringLLM(answer, [
        { marker: 1, sourceId: 'P1', quote: 'Apollo ships' },
        { marker: 2, sourceId: 'P2', quote: 'board approved the budget' },
      ]),
    ).answerOverSources({
      tenantId: TENANT,
      question: 'What is the Apollo status?',
      subject: 'Apollo',
      sources: apolloSrc,
      completeness: { mayHaveUnlinkedRecords: false, recordCount: 2 },
      actor: ACTOR,
    });
    expect(result.status).toBe('answered');
    expect(result.answer).toBe(answer); // every sentence cited → verbatim, no trimming
    expect(result.citations).toHaveLength(2);
  });
});

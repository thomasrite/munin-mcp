// Result-shape unit tests (S2 deliverables 1 + 3): the retrieval/answer tools
// carry the stable citationGuidance field AND keep their structured fields
// (sourceId, citations, recentDocuments) intact. Stubs stand in for the engine
// classes — no DB needed; the int test proves the same shapes against Postgres.

import { COUNT_DECLINE_MESSAGE, type ContextSource } from '@muninhq/engine';
import { describe, expect, it } from 'vitest';

import { testConfiguration } from '../test-fixtures';
import { ask } from './ask';
import { ASK_CITATION_GUIDANCE, SOURCES_CITATION_GUIDANCE } from './citation-guidance';
import { gatherEntity } from './gather-entity';
import { retrieveContext } from './retrieve-context';
import { computeCiteAs } from './shaping';
import { status } from './status';
import type { ToolDeps } from './types';

// Structural stubs for the three engine seams the tools touch. Cast through
// unknown because the real types are concrete engine classes, not interfaces.
function deps(parts: {
  pipeline?: unknown;
  retriever?: unknown;
  store?: unknown;
}): ToolDeps {
  return {
    configuration: testConfiguration(),
    tenantId: 'tenant-1',
    schemaHash: 'schema-hash',
    context: {
      kind: 'regular',
      tenantId: 'tenant-1',
      accessTags: ['red'],
      actor: 'mcp:local-user',
    },
    store: parts.store ?? {},
    retriever: parts.retriever ?? {},
    pipeline: parts.pipeline ?? {},
    // reason: structural stubs — only the methods each tool calls are provided.
  } as unknown as ToolDeps;
}

function source(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    sourceId: 'P1',
    method: 'vector',
    distance: 0.1,
    documentTitle: 'Doc One',
    paragraph: {
      id: 'para-1',
      tenantId: 'tenant-1',
      documentId: 'doc-1',
      paragraphIndex: 0,
      page: null,
      text: 'Doughnut economics reframes growth.',
      structure: 'prose',
      accessTags: ['red'],
      createdBy: 'actor',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      deletedAt: null,
      // reason: test fixture — branded-ID fields are plain strings here.
    } as never,
    ...overrides,
  };
}

describe('ask result shape (open path)', () => {
  it('keeps status + citations, adds the unified citeAs token, and the ask citation guidance', async () => {
    let answerFromContextCalled = false;
    const pipeline = {
      answer: async () => ({
        status: 'answered' as const,
        answer: 'Doughnut economics reframes growth [1].',
        citations: [{ marker: 1, documentId: 'doc-1', paragraphId: 'para-1', quote: 'Doughnut' }],
      }),
      answerFromContext: async () => {
        answerFromContextCalled = true;
        return { status: 'answered' as const, answer: '', citations: [] };
      },
    };
    const result = await ask(deps({ pipeline }), { question: 'what is doughnut economics?' });
    // No subject → the OPEN path (QueryPipeline.answer); entity routing untouched.
    expect(answerFromContextCalled).toBe(false);
    expect(result.status).toBe('answered');
    if (result.status === 'disambiguation') throw new Error('unexpected disambiguation');
    // citeAs now unifies ask's citations with the source-returning tools' tokens.
    expect(result.citations).toEqual([
      {
        marker: 1,
        documentId: 'doc-1',
        paragraphId: 'para-1',
        quote: 'Doughnut',
        citeAs: computeCiteAs('doc-1', 'para-1'),
      },
    ]);
    expect(result.citations[0]?.citeAs).toMatch(/^S[0-9a-f]{12}$/);
    // The open path adds no entity-routing fields.
    expect(result.subject).toBeUndefined();
    expect(result.completenessNote).toBeUndefined();
    expect(result.citationGuidance).toBe(ASK_CITATION_GUIDANCE);
  });

  it('carries the guidance on no_evidence too (and keeps citations empty)', async () => {
    const pipeline = {
      answer: async () => ({
        status: 'no_evidence' as const,
        answer: 'No evidence.',
        citations: [],
      }),
    };
    const result = await ask(deps({ pipeline }), { question: 'unknown?' });
    expect(result.status).toBe('no_evidence');
    if (result.status === 'disambiguation') throw new Error('unexpected disambiguation');
    expect(result.citations).toEqual([]);
    expect(result.citationGuidance).toBe(ASK_CITATION_GUIDANCE);
  });
});

describe('ask entity-routing (optional subject/pick)', () => {
  it('routes through the retriever + answerFromContext when a subject is given (not the open answer path)', async () => {
    let answerCalled = false;
    let answerFromContextCalled = false;
    let routedQuestion = '';
    const retriever = {
      retrieveContext: async (_ctx: unknown, req: { question: string; identity?: unknown }) => {
        routedQuestion = req.question;
        return {
          kind: 'context' as const,
          method: 'gather',
          classification: 'entity',
          sources: [source()],
          message: 'grounding',
          subject: 'A. Example',
          completeness: { subject: 'A. Example', recordCount: 3, mayHaveUnlinkedRecords: false },
        };
      },
    };
    const pipeline = {
      answer: async () => {
        answerCalled = true;
        return { status: 'answered' as const, answer: '', citations: [] };
      },
      answerFromContext: async () => {
        answerFromContextCalled = true;
        return {
          status: 'answered' as const,
          answer: 'Everything known about them [1].',
          citations: [{ marker: 1, documentId: 'doc-1', paragraphId: 'para-1', quote: 'q' }],
          completeness: { subject: 'A. Example', recordCount: 3, complete: true, note: null },
        };
      },
    };
    const result = await ask(deps({ retriever, pipeline }), {
      question: 'tell me everything',
      subject: 'A. Example',
    });
    expect(answerCalled).toBe(false);
    expect(answerFromContextCalled).toBe(true);
    // The subject is folded into the question so classification routes entity-centric.
    expect(routedQuestion).toMatch(/A\. Example/);
    if (result.status === 'disambiguation') throw new Error('unexpected disambiguation');
    expect(result.subject).toBe('A. Example');
    expect(result.completenessNote).toBeNull(); // complete gather → no note
    expect(result.citations[0]?.citeAs).toMatch(/^S[0-9a-f]{12}$/);
  });

  it('surfaces the engine completeness note when the gather may be incomplete', async () => {
    const retriever = {
      retrieveContext: async () => ({
        kind: 'context' as const,
        method: 'gather',
        classification: 'entity',
        sources: [source()],
        message: 'grounding',
        subject: 'A. Example',
        completeness: { subject: 'A. Example', recordCount: 2, mayHaveUnlinkedRecords: true },
      }),
    };
    const pipeline = {
      answerFromContext: async () => ({
        status: 'answered' as const,
        answer: 'Partial [1].',
        citations: [{ marker: 1, documentId: 'doc-1', paragraphId: 'para-1', quote: 'q' }],
        completeness: {
          subject: 'A. Example',
          recordCount: 2,
          complete: false,
          note: 'Based on 2 records; there may be further records that could not be linked to this subject.',
        },
      }),
    };
    const result = await ask(deps({ retriever, pipeline }), {
      question: 'q',
      subject: 'A. Example',
    });
    if (result.status === 'disambiguation') throw new Error('unexpected disambiguation');
    expect(result.completenessNote).toMatch(/may be further records/i);
  });

  it('surfaces a disambiguation when several subjects share the name', async () => {
    const retriever = {
      retrieveContext: async () => ({
        kind: 'disambiguation' as const,
        subject: 'Casey',
        pickWasStale: false,
        group: {
          candidates: [
            {
              token: 't1',
              logicalKey: 'Casey A',
              entityType: 'Alpha',
              distinguishing: { group: ['A'] },
              visibleRecordCount: 2,
            },
            {
              token: 't2',
              logicalKey: 'Casey B',
              entityType: 'Alpha',
              distinguishing: { group: ['B'] },
              visibleRecordCount: 1,
            },
          ],
        },
      }),
    };
    const result = await ask(deps({ retriever }), {
      question: 'tell me about Casey',
      subject: 'Casey',
    });
    expect(result.status).toBe('disambiguation');
    if (result.status !== 'disambiguation') throw new Error('expected disambiguation');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.pick).toBe('t1');
    // An ask-originated disambiguation must keep the client on munin_ask — never
    // steer it to the weaker advisory tool (the re-steer would otherwise leak here).
    expect(result.message).toContain('munin_ask');
    expect(result.message).not.toContain('munin_gather_entity');
  });

  it('declines an aggregation/counting question on the entity-routed path BEFORE retrieving', async () => {
    let retrieveCalled = false;
    const retriever = {
      retrieveContext: async () => {
        retrieveCalled = true;
        return {
          kind: 'context' as const,
          method: 'gather',
          sources: [],
          message: null,
          subject: null,
          completeness: null,
        };
      },
    };
    const result = await ask(deps({ retriever }), {
      question: 'how many cases does A. Example have?',
      subject: 'A. Example',
    });
    expect(retrieveCalled).toBe(false);
    if (result.status === 'disambiguation') throw new Error('unexpected disambiguation');
    expect(result.status).toBe('no_evidence');
    expect(result.answer).toBe(COUNT_DECLINE_MESSAGE);
    expect(result.citations).toEqual([]);
  });
});

describe('retrieve_context result shape', () => {
  it('keeps the cited sources and adds the sources citation guidance', async () => {
    const retriever = {
      retrieveContext: async () => ({
        kind: 'context' as const,
        method: 'vector',
        classification: 'open',
        sources: [source()],
        message: 'grounding',
        subject: null,
        completeness: null,
      }),
    };
    const result = await retrieveContext(deps({ retriever }), { question: 'q' });
    expect(result.status).toBe('context');
    if (result.status !== 'context') throw new Error('expected context');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.sourceId).toBe('P1');
    expect(result.sources[0]?.citeAs).toMatch(/^S[0-9a-f]{12}$/);
    expect(result.sources[0]?.documentId).toBe('doc-1');
    expect(result.citationGuidance).toBe(SOURCES_CITATION_GUIDANCE);
  });

  it('citeAs is STABLE across two separate calls and DISTINCT across sources', async () => {
    // A second paragraph in a different document — the engine reassigns sourceId
    // P1 on EVERY call, so only an identity-derived citeAs can hold across calls.
    const para2 = source({
      sourceId: 'P2',
      paragraph: {
        id: 'para-2',
        documentId: 'doc-2',
        text: 'A second paragraph.',
      } as never,
    });
    // First call surfaces [para-1, para-2]; a later call surfaces para-1 alone,
    // where the engine now labels it P1 — mirroring the cross-call collision.
    const callOne = {
      retrieveContext: async () => ({
        kind: 'context' as const,
        method: 'vector',
        classification: 'open',
        sources: [source(), para2],
        message: 'grounding',
        subject: null,
        completeness: null,
      }),
    };
    const callTwo = {
      retrieveContext: async () => ({
        kind: 'context' as const,
        method: 'vector',
        classification: 'open',
        sources: [source()],
        message: 'grounding',
        subject: null,
        completeness: null,
      }),
    };

    const first = await retrieveContext(deps({ retriever: callOne }), { question: 'q' });
    const second = await retrieveContext(deps({ retriever: callTwo }), { question: 'q again' });
    if (first.status !== 'context' || second.status !== 'context') {
      throw new Error('expected context');
    }

    // Distinct sources within one result get distinct tokens.
    expect(first.sources[0]?.citeAs).not.toBe(first.sources[1]?.citeAs);
    // The SAME paragraph (doc-1/para-1) keeps the SAME citeAs across calls, even
    // though its per-call sourceId is P1 in both — the collision citeAs fixes.
    expect(second.sources[0]?.sourceId).toBe('P1');
    expect(second.sources[0]?.citeAs).toBe(first.sources[0]?.citeAs);
  });
});

describe('retrieve_context aggregation guard', () => {
  it('declines a counting question with a structured note and does NOT retrieve', async () => {
    let retrieveCalled = false;
    const retriever = {
      retrieveContext: async () => {
        retrieveCalled = true;
        return {
          kind: 'context' as const,
          method: 'vector',
          classification: 'open',
          sources: [source()],
          message: 'grounding',
          subject: null,
          completeness: null,
        };
      },
    };
    const result = await retrieveContext(deps({ retriever }), {
      question: 'how many records are there in total?',
    });
    // No embedding spend — declined before any retrieval, mirroring munin_ask.
    expect(retrieveCalled).toBe(false);
    expect(result.status).toBe('aggregation_unsupported');
    if (result.status !== 'aggregation_unsupported') throw new Error('expected aggregation note');
    // Mirrors the pipeline's COUNT_DECLINE_MESSAGE and explains the partial-sample reason.
    expect(result.note).toContain(COUNT_DECLINE_MESSAGE);
    expect(result.note).toMatch(/partial sample/i);
  });

  it('still retrieves normally for a non-counting question', async () => {
    const retriever = {
      retrieveContext: async () => ({
        kind: 'context' as const,
        method: 'vector',
        classification: 'open',
        sources: [source()],
        message: 'grounding',
        subject: null,
        completeness: null,
      }),
    };
    const result = await retrieveContext(deps({ retriever }), {
      question: 'what is doughnut economics?',
    });
    expect(result.status).toBe('context');
  });
});

describe('gather_entity result shape', () => {
  it('keeps the gathered sources and adds the sources citation guidance', async () => {
    const retriever = {
      retrieveContext: async () => ({
        kind: 'context' as const,
        method: 'gather',
        classification: 'entity',
        sources: [source()],
        message: 'grounding',
        subject: 'A. Example',
        completeness: { subject: 'A. Example', recordCount: 3, mayHaveUnlinkedRecords: false },
      }),
    };
    const result = await gatherEntity(deps({ retriever }), { subject: 'A. Example' });
    expect(result.status).toBe('gathered');
    if (result.status !== 'gathered') throw new Error('expected gathered');
    expect(result.recordCount).toBe(3);
    expect(result.sources[0]?.sourceId).toBe('P1');
    expect(result.citationGuidance).toBe(SOURCES_CITATION_GUIDANCE);
  });
});

describe('status result shape', () => {
  it('keeps the counts and adds recentDocuments (newest first, content-free)', async () => {
    const doc = (id: string, title: string, created: string) => ({
      id,
      title,
      createdAt: new Date(created),
    });
    const store = {
      findDocuments: async () => ({
        items: [
          doc('d2', 'Newer Doc', '2026-02-01T00:00:00.000Z'),
          doc('d1', 'Older Doc', '2026-01-01T00:00:00.000Z'),
        ],
        total: 2,
      }),
      findEntities: async () => ({ items: [], total: 7 }),
      findParagraphsPendingExtraction: async () => [],
      findParagraphsByDocument: async () => [],
    };
    const result = await status(deps({ store }));
    expect(result.documentCount).toBe(2);
    expect(result.entityCount).toBe(7);
    expect(result.recentDocuments).toEqual([
      { documentId: 'd2', title: 'Newer Doc', ingestedAt: '2026-02-01T00:00:00.000Z' },
      { documentId: 'd1', title: 'Older Doc', ingestedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('omits paragraphCount (null) for a corpus beyond the cheap-count cap', async () => {
    // total beyond PARAGRAPH_COUNT_DOC_CAP → the per-document walk is skipped and
    // the count is reported null (no silent wrong number), but recentDocuments and
    // the document total still come from the single page.
    let paragraphWalkCalled = false;
    const store = {
      findDocuments: async () => ({
        items: [{ id: 'd1', title: 'A', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
        total: 5000,
      }),
      findEntities: async () => ({ items: [], total: 0 }),
      findParagraphsPendingExtraction: async () => [],
      findParagraphsByDocument: async () => {
        paragraphWalkCalled = true;
        return [];
      },
    };
    const result = await status(deps({ store }));
    expect(result.documentCount).toBe(5000);
    expect(result.paragraphCount).toBeNull();
    expect(result.recentDocuments).toHaveLength(1);
    // The expensive per-document walk must NOT run past the cap.
    expect(paragraphWalkCalled).toBe(false);
  });
});

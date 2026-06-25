// M2.1 grounded-generation core — unit tests. A scriptable fake LLMProvider
// returns a submit_document tool call; the tests assert the grounding /
// fail-closed / completeness-honesty / permission-shape guarantees deterministically
// (no real model). Real-Opus faithfulness is measured separately in the harness.

import { describe, expect, it } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import {
  type NewLlmCall,
  type Paragraph,
  asActorId,
  asDocumentId,
  asParagraphId,
  asTenantId,
} from '../graph/types';
import {
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ProviderCallContext,
  type ProviderCapabilities,
  StubLLMProvider,
} from '../providers';
import {
  type GenerateRequest,
  type GenerationSource,
  GenerationTruncatedError,
  generateDocument,
} from './generate';
import { GENERATION_TOOL_NAME } from './generation-prompt';
import { SECTION_RELEVANCE_TOOL_NAME } from './section-relevance-prompt';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const ACTOR = asActorId('gen-test');
const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

function para(idHex: string, text: string): Paragraph {
  return {
    id: asParagraphId(`00000000-0000-0000-0000-0000000000${idHex}`),
    tenantId: TENANT,
    documentId: asDocumentId(`00000000-0000-0000-0000-0000000000d${idHex[0]}`),
    paragraphIndex: 0,
    page: 1,
    text,
    structure: {},
    accessTags: ['public'],
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

// A fake provider that returns a fixed submit_document input and captures the
// request it was given.
function fakeLLM(
  documentInput: unknown,
  responseOverrides: Partial<LLMResponse> = {},
): {
  llm: LLMProvider;
  captured: () => LLMRequest | undefined;
} {
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
          { id: 't1', name: GENERATION_TOOL_NAME, input: documentInput as Record<string, unknown> },
        ],
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        modelId: 'claude-opus-4-7',
        stopReason: 'tool_use',
        ...responseOverrides,
      };
    },
  };
  return { llm, captured: () => captured };
}

const CTX: ProviderCallContext = { tenantId: TENANT, purpose: 'other', graphStore: {} as never };

const SOURCES: GenerationSource[] = [
  {
    sourceId: 'P1',
    paragraph: para('01', 'Helena Voss raised a grievance on 3 March about workload.'),
  },
  { sourceId: 'P2', paragraph: para('02', 'The grievance outcome upheld the complaint in part.') },
];

function baseReq(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    subject: 'Helena Voss',
    sections: [{ heading: 'Summary', instruction: 'Summarise the records.' }],
    sources: SOURCES,
    completeness: { mayHaveUnlinkedRecords: false, recordCount: 2 },
    ...overrides,
  };
}

describe('generateDocument — grounding (the hard bar)', () => {
  it('renders grounded claims with sequential markers and citations bound to the cited paragraph', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Helena Voss raised a grievance on 3 March about workload.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
              ],
            },
            {
              text: 'The outcome upheld the complaint in part.',
              citations: [{ sourceId: 'P2', quote: 'upheld the complaint in part' }],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('generated');
    expect(doc.citations).toHaveLength(2);
    expect(doc.citations.map((c) => c.marker)).toEqual([1, 2]);
    expect(doc.body).toContain('[1]');
    expect(doc.body).toContain('[2]');
    expect(doc.citations[0]!.paragraphId).toBe(SOURCES[0]!.paragraph.id);
    expect(doc.droppedClaims).toBe(0);
  });

  it('a consolidated claim KEEPS all its citations (multi-citation; de-dup preserves provenance)', async () => {
    // One claim merging two near-identical records → two grounded citations, two
    // markers on the one claim (refinement 2: de-dup must not drop provenance).
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Two grievances were raised and recorded.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                { sourceId: 'P2', quote: 'upheld the complaint in part' },
              ],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('generated');
    expect(doc.citations).toHaveLength(2);
    expect(doc.sections[0]!.claims).toHaveLength(1);
    expect(doc.sections[0]!.claims[0]!.markers).toEqual([1, 2]);
    expect(doc.body).toContain('Two grievances were raised and recorded. [1][2]');
  });

  it('within a multi-citation claim, an ungrounded citation is dropped but the grounded one survives', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'A grievance was raised.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                { sourceId: 'P2', quote: 'fabricated quote that does not appear' },
              ],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('generated');
    expect(doc.sections[0]!.claims[0]!.markers).toEqual([1]); // only the grounded citation
    expect(doc.droppedClaims).toBe(1); // the ungrounded citation was dropped
    expect(doc.citations).toHaveLength(1);
  });

  it('exposes structured sections (provenance can be rendered downstream — refinement 1)', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'A grievance was raised.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
              ],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.heading).toBe('Summary');
    expect(doc.sections[0]!.gap).toBe(false);
    expect(doc.sections[0]!.claims[0]!.text).toBe('A grievance was raised.');
  });

  it('DROPS an ungrounded claim — its text never reaches output (fail-closed, literal)', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Helena Voss raised a grievance on 3 March about workload.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
              ],
            },
            // Fabricated: this quote is NOT in any source.
            {
              text: 'Helena Voss was dismissed for gross misconduct.',
              citations: [{ sourceId: 'P2', quote: 'dismissed for gross misconduct' }],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('generated');
    expect(doc.droppedClaims).toBe(1);
    // The fabricated claim's TEXT is absent, not merely its marker.
    expect(doc.body).not.toContain('gross misconduct');
    expect(doc.body).not.toContain('dismissed');
    expect(doc.citations).toHaveLength(1);
  });

  it('drops a claim citing a source NOT in the gathered set (out-of-set)', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [{ text: 'Something.', citations: [{ sourceId: 'P99', quote: 'whatever' }] }],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('no_evidence'); // nothing grounded
    expect(doc.droppedClaims).toBe(1);
  });

  it('marks a section gap when it has no grounded claim, but keeps grounded sections', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Helena Voss raised a grievance on 3 March about workload.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
              ],
            },
          ],
        },
        { heading: 'Disciplinary history', claims: [] }, // no support → gap
      ],
    });
    const doc = await generateDocument(
      llm,
      CTX,
      baseReq({
        sections: [
          { heading: 'Summary', instruction: 's' },
          { heading: 'Disciplinary history', instruction: 'd' },
        ],
      }),
    );
    expect(doc.status).toBe('generated');
    expect(doc.body).toContain('## Disciplinary history');
    expect(doc.body).toContain('No record found for this section');
  });

  it('fails the document closed when NO claim grounds anywhere (systemic failure)', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Invented.',
              citations: [{ sourceId: 'P1', quote: 'this quote is not present at all' }],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('no_evidence');
    expect(doc.body).toBe('');
    expect(doc.citations).toHaveLength(0);
  });

  it('fails closed without calling the model when there are no sources', async () => {
    let called = false;
    const llm: LLMProvider = {
      id: 'fake',
      capabilities: CAPS,
      defaultModel: 'm',
      async complete(): Promise<LLMResponse> {
        called = true;
        return {
          text: '',
          toolCalls: [],
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          modelId: 'm',
          stopReason: 'tool_use',
        };
      },
    };
    const doc = await generateDocument(llm, CTX, baseReq({ sources: [] }));
    expect(doc.status).toBe('no_evidence');
    expect(called).toBe(false);
  });

  it('honours the model no_evidence verdict', async () => {
    const { llm } = fakeLLM({ status: 'no_evidence', sections: [] });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('no_evidence');
  });
});

describe('generateDocument — truncation guard (F30: never silent no_evidence)', () => {
  it('THROWS GenerationTruncatedError when the call hits the output-token ceiling', async () => {
    // A real Opus truncation: stop=max_tokens, output at the cap, and the
    // tool-call JSON is incomplete. The model "would" have grounded richly — the
    // call was cut off. This must NOT be swallowed as no_evidence.
    const { llm } = fakeLLM(
      // A partial, still-parseable-looking input is irrelevant: the guard fires
      // on stopReason BEFORE parsing, so even a salvageable body is rejected.
      {
        status: 'generated',
        sections: [
          {
            heading: 'Summary',
            claims: [
              {
                text: 'Helena Voss raised a grievance on 3 March about workload.',
                citations: [
                  { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                ],
              },
            ],
          },
        ],
      },
      { stopReason: 'max_tokens', outputTokens: 4096 },
    );
    await expect(generateDocument(llm, CTX, baseReq({ maxOutputTokens: 4096 }))).rejects.toThrow(
      GenerationTruncatedError,
    );
  });

  it('the thrown error carries the token figures and is NOT a no_evidence document', async () => {
    const { llm } = fakeLLM(
      { status: 'generated', sections: [] },
      {
        stopReason: 'max_tokens',
        outputTokens: 8192,
      },
    );
    let caught: unknown;
    try {
      await generateDocument(llm, CTX, baseReq({ maxOutputTokens: 8192 }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GenerationTruncatedError);
    const err = caught as GenerationTruncatedError;
    expect(err.outputTokens).toBe(8192);
    expect(err.maxOutputTokens).toBe(8192);
  });

  it('a NON-truncated empty result is still honest no_evidence (guard does not over-fire)', async () => {
    // stop=tool_use (normal) + genuinely no grounded claims → no_evidence, NOT
    // an error. The guard fires ONLY on max_tokens.
    const { llm } = fakeLLM({ status: 'no_evidence', sections: [] }, { stopReason: 'tool_use' });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.status).toBe('no_evidence');
  });
});

// ---------------------------------------------------------------------------
// F30 — SECTION-CHUNKED assembly. These tests prove the merge layer EXPLICITLY
// (not "by construction"): one LLM call per section, with the fake returning a
// DIFFERENT response per section so cross-chunk effects are observable.
// ---------------------------------------------------------------------------

// A section-aware fake: it reads the requested <section heading="…"> from the
// rendered user message and returns the scripted response for THAT heading. Also
// records how many calls were made and the per-call max-token caps, so we can
// assert "one call per section". Per-heading stopReason override supports the
// truncated-chunk test.
function sectionAwareLLM(
  byHeading: Record<
    string,
    { input: unknown; stopReason?: LLMResponse['stopReason']; outputTokens?: number }
  >,
): { llm: LLMProvider; calls: () => number; sectionCalls: () => number; routeCalls: () => number } {
  let routeCalls = 0;
  let sectionCalls = 0;
  const llm: LLMProvider = {
    id: 'fake-section',
    capabilities: CAPS,
    defaultModel: 'claude-opus-4-7',
    async complete(req: LLMRequest): Promise<LLMResponse> {
      // The Move 1 routing pre-step: count it, then return no routing tool so the
      // section calls fall back to the FULL set — identical behaviour to before
      // Move 1, which is exactly what these F30 assembly tests expect.
      if (req.toolChoice?.name === SECTION_RELEVANCE_TOOL_NAME) {
        routeCalls += 1;
        return {
          text: '',
          toolCalls: [],
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          modelId: req.model ?? 'fake',
          stopReason: 'tool_use',
        };
      }
      sectionCalls += 1;
      const userText = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      const heading = userText.match(/<section heading="([^"]*)"/)?.[1] ?? '';
      const scripted = byHeading[heading] ?? { input: { status: 'no_evidence', sections: [] } };
      return {
        text: '',
        toolCalls: [
          {
            id: `t${sectionCalls}`,
            name: GENERATION_TOOL_NAME,
            input: scripted.input as Record<string, unknown>,
          },
        ],
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: scripted.outputTokens ?? 1,
        modelId: 'claude-opus-4-7',
        stopReason: scripted.stopReason ?? 'tool_use',
      };
    },
  };
  return {
    llm,
    calls: () => routeCalls + sectionCalls,
    sectionCalls: () => sectionCalls,
    routeCalls: () => routeCalls,
  };
}

describe('generateDocument — section-chunked assembly (F30)', () => {
  it('runs ONE writing call per section plus ONE routing pre-step (never one call for the whole document)', async () => {
    const { llm, sectionCalls, routeCalls } = sectionAwareLLM({
      A: { input: { status: 'generated', sections: [{ heading: 'A', claims: [] }] } },
      B: { input: { status: 'generated', sections: [{ heading: 'B', claims: [] }] } },
      C: { input: { status: 'generated', sections: [{ heading: 'C', claims: [] }] } },
    });
    await generateDocument(
      llm,
      CTX,
      baseReq({
        sections: [
          { heading: 'A', instruction: 'a' },
          { heading: 'B', instruction: 'b' },
          { heading: 'C', instruction: 'c' },
        ],
      }),
    );
    // F30: one writing call PER SECTION — never one for the whole document.
    expect(sectionCalls()).toBe(3);
    // Move 1: exactly one cheap routing pre-step for the whole document.
    expect(routeCalls()).toBe(1);
  });

  it('re-numbers citation markers GLOBALLY across chunks — no collision after merge', async () => {
    // Each section call emits its OWN claims numbered from its own perspective
    // (the model restarts marker thinking per call). After merge, markers must be
    // globally unique and contiguous (1,2,3) and each must bind to the right
    // paragraph — proving the assembly layer renumbers, not the model.
    const { llm } = sectionAwareLLM({
      First: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'First',
              claims: [
                {
                  text: 'Grievance raised on 3 March.',
                  citations: [
                    { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                  ],
                },
              ],
            },
          ],
        },
      },
      Second: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'Second',
              claims: [
                // Two citations in this section; cites P2 then P1 (out of order on
                // purpose). Global numbering must continue from the first section.
                {
                  text: 'Outcome upheld in part; relates to the earlier grievance.',
                  citations: [
                    { sourceId: 'P2', quote: 'upheld the complaint in part' },
                    { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const doc = await generateDocument(
      llm,
      CTX,
      baseReq({
        sections: [
          { heading: 'First', instruction: 'a' },
          { heading: 'Second', instruction: 'b' },
        ],
      }),
    );
    expect(doc.status).toBe('generated');
    // Three citations total across the two sections, globally numbered 1,2,3.
    expect(doc.citations.map((c) => c.marker)).toEqual([1, 2, 3]);
    // Marker 1 is the first section's P1; markers 2 and 3 are the second
    // section's P2 then P1 — each bound to the CORRECT paragraph (no mislink).
    const p1 = SOURCES[0]!.paragraph;
    const p2 = SOURCES[1]!.paragraph;
    expect(doc.citations[0]!.paragraphId).toBe(p1.id);
    expect(doc.citations[1]!.paragraphId).toBe(p2.id);
    expect(doc.citations[2]!.paragraphId).toBe(p1.id);
    // The second section's claim references both of its (renumbered) markers.
    const second = doc.sections.find((s) => s.heading === 'Second')!;
    expect(second.claims[0]!.markers).toEqual([2, 3]);
    // Body markers are contiguous and unique.
    expect(doc.body).toContain('[1]');
    expect(doc.body).toContain('[2]');
    expect(doc.body).toContain('[3]');
  });

  it('a TRUNCATED chunk surfaces via the guard — never a silent empty section', async () => {
    // The first section grounds fine; the SECOND section's call hits the
    // output-token ceiling. The whole generation must throw (loud) rather than
    // quietly returning a document with an empty second section.
    const { llm } = sectionAwareLLM({
      Good: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'Good',
              claims: [
                {
                  text: 'Grievance raised on 3 March.',
                  citations: [
                    { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                  ],
                },
              ],
            },
          ],
        },
      },
      Truncated: {
        // Would parse to something, but stop=max_tokens fires the guard first.
        input: { status: 'generated', sections: [{ heading: 'Truncated', claims: [] }] },
        stopReason: 'max_tokens',
        outputTokens: 4096,
      },
    });
    await expect(
      generateDocument(
        llm,
        CTX,
        baseReq({
          maxOutputTokens: 4096,
          sections: [
            { heading: 'Good', instruction: 'a' },
            { heading: 'Truncated', instruction: 'b' },
          ],
        }),
      ),
    ).rejects.toThrow(GenerationTruncatedError);
  });

  it('cross-chunk claim accounting + gap handling: grounded sections render, empty ones gap, dropped count sums across calls', async () => {
    const { llm } = sectionAwareLLM({
      Grounded: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'Grounded',
              claims: [
                {
                  text: 'Grievance raised on 3 March.',
                  citations: [
                    { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                  ],
                },
                // This claim's quote does NOT appear verbatim → dropped (counted).
                {
                  text: 'A fabricated detail.',
                  citations: [{ sourceId: 'P1', quote: 'this quote is not in the paragraph' }],
                },
              ],
            },
          ],
        },
      },
      // This section's call grounds nothing it emitted — its claim is dropped too.
      Ungrounded: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'Ungrounded',
              claims: [
                {
                  text: 'Another fabrication.',
                  citations: [{ sourceId: 'P2', quote: 'also not present verbatim' }],
                },
              ],
            },
          ],
        },
      },
      // This section genuinely has nothing — model returned no_evidence.
      Empty: { input: { status: 'no_evidence', sections: [] } },
    });
    const doc = await generateDocument(
      llm,
      CTX,
      baseReq({
        sections: [
          { heading: 'Grounded', instruction: 'a' },
          { heading: 'Ungrounded', instruction: 'b' },
          { heading: 'Empty', instruction: 'c' },
        ],
      }),
    );
    expect(doc.status).toBe('generated'); // at least one claim survived
    // Exactly one surviving citation (the one verbatim-grounded claim).
    expect(doc.citations).toHaveLength(1);
    expect(doc.citations[0]!.marker).toBe(1);
    // Two dropped (one in Grounded, one in Ungrounded) — summed across calls.
    expect(doc.droppedClaims).toBe(2);
    // All three section headings are preserved; the two without survivors gap.
    expect(doc.sections.map((s) => s.heading)).toEqual(['Grounded', 'Ungrounded', 'Empty']);
    expect(doc.sections.find((s) => s.heading === 'Grounded')!.gap).toBe(false);
    expect(doc.sections.find((s) => s.heading === 'Ungrounded')!.gap).toBe(true);
    expect(doc.sections.find((s) => s.heading === 'Empty')!.gap).toBe(true);
  });

  it('completeness banner accounts ONCE for the whole document, independent of section-call count', async () => {
    const { llm } = sectionAwareLLM({
      A: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'A',
              claims: [
                {
                  text: 'Grievance raised on 3 March.',
                  citations: [
                    { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                  ],
                },
              ],
            },
          ],
        },
      },
      B: {
        input: {
          status: 'generated',
          sections: [
            {
              heading: 'B',
              claims: [
                {
                  text: 'Outcome upheld in part.',
                  citations: [{ sourceId: 'P2', quote: 'upheld the complaint in part' }],
                },
              ],
            },
          ],
        },
      },
    });
    const doc = await generateDocument(
      llm,
      CTX,
      baseReq({
        completeness: { mayHaveUnlinkedRecords: true, recordCount: 35 },
        sections: [
          { heading: 'A', instruction: 'a' },
          { heading: 'B', instruction: 'b' },
        ],
      }),
    );
    expect(doc.completeness.complete).toBe(false);
    expect(doc.completeness.recordCount).toBe(35); // not multiplied by call count
    expect(doc.completeness.note).toContain('35 records');
    expect(doc.completeness.note).toContain('could not be linked');
  });
});

// ---------------------------------------------------------------------------
// Move 1 — per-section source scoping (cheap Haiku routing pre-step). Cost only;
// grounding is sacred: a routing miss can only GAP a section, never produce an
// ungrounded/fabricated claim (resolve is unchanged, verifying every surviving
// quote against the caller's FULL gathered set).
// ---------------------------------------------------------------------------

// A routing-aware fake: it answers the route_sources pre-step with the scripted
// routing, then answers each submit_document section call by heading — capturing
// the exact user message each section saw, and the model each call used.
function routingAwareLLM(opts: {
  routing: Record<string, number[]>; // sourceId -> 1-based section numbers
  byHeading: Record<string, { input: unknown }>;
}): {
  llm: LLMProvider;
  userMessageFor: (heading: string) => string | undefined;
  routeModel: () => string | undefined;
  sectionModels: () => string[];
} {
  const captured = new Map<string, string>();
  const sectionModels: string[] = [];
  let routeModel: string | undefined;
  const llm: LLMProvider = {
    id: 'fake-routing',
    capabilities: CAPS,
    defaultModel: 'claude-opus-4-7',
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const userText = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      if (req.toolChoice?.name === SECTION_RELEVANCE_TOOL_NAME) {
        routeModel = req.model;
        const sources = Object.entries(opts.routing).map(([sourceId, sectionNumbers]) => ({
          sourceId,
          sectionNumbers,
        }));
        return {
          text: '',
          toolCalls: [{ id: 'r', name: SECTION_RELEVANCE_TOOL_NAME, input: { sources } }],
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          modelId: req.model ?? 'fake',
          stopReason: 'tool_use',
        };
      }
      sectionModels.push(req.model ?? 'unknown');
      const heading = userText.match(/<section heading="([^"]*)"/)?.[1] ?? '';
      captured.set(heading, userText);
      const scripted = opts.byHeading[heading] ?? {
        input: { status: 'no_evidence', sections: [] },
      };
      return {
        text: '',
        toolCalls: [
          { id: 's', name: GENERATION_TOOL_NAME, input: scripted.input as Record<string, unknown> },
        ],
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        modelId: req.model ?? 'claude-opus-4-7',
        stopReason: 'tool_use',
      };
    },
  };
  return {
    llm,
    userMessageFor: (h) => captured.get(h),
    routeModel: () => routeModel,
    sectionModels: () => sectionModels,
  };
}

const TWO_SECTIONS = [
  { heading: 'Summary', instruction: 's' },
  { heading: 'History', instruction: 'h' },
];

describe('generateDocument — section scoping (Move 1)', () => {
  it('routes each section to ONLY its scoped sources (the dominant input saving)', async () => {
    const { llm, userMessageFor } = routingAwareLLM({
      routing: { P1: [1], P2: [2] }, // P1 → Summary only; P2 → History only
      byHeading: {
        Summary: {
          input: {
            status: 'generated',
            sections: [
              {
                heading: 'Summary',
                claims: [
                  {
                    text: 'A grievance was raised.',
                    citations: [
                      { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                    ],
                  },
                ],
              },
            ],
          },
        },
        History: {
          input: {
            status: 'generated',
            sections: [
              {
                heading: 'History',
                claims: [
                  {
                    text: 'The outcome upheld the complaint in part.',
                    citations: [{ sourceId: 'P2', quote: 'upheld the complaint in part' }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const doc = await generateDocument(llm, CTX, baseReq({ sections: TWO_SECTIONS }));

    // Summary's call saw P1's text but NOT P2's; History's saw P2's but NOT P1's.
    const summaryMsg = userMessageFor('Summary')!;
    const historyMsg = userMessageFor('History')!;
    expect(summaryMsg).toContain('workload'); // P1
    expect(summaryMsg).not.toContain('upheld the complaint'); // not P2
    expect(historyMsg).toContain('upheld the complaint'); // P2
    expect(historyMsg).not.toContain('workload'); // not P1

    // Both sections still ground — each cites its scoped, real source.
    expect(doc.status).toBe('generated');
    expect(doc.citations).toHaveLength(2);
  });

  it('a routing MISS can only GAP a section — an ungroundable claim is still dropped (grounding sacred)', async () => {
    // History is mis-routed: given only P1; P2 (the source it needs) is routed to
    // Summary only. Seeing the wrong source, the History call emits a claim whose
    // quote is in NO source → the unchanged per-claim verifier drops it → History
    // gaps. The miss costs a section's content; it NEVER yields a fabricated claim.
    const { llm, userMessageFor } = routingAwareLLM({
      routing: { P1: [1, 2], P2: [1] }, // History (section 2) gets only P1
      byHeading: {
        Summary: {
          input: {
            status: 'generated',
            sections: [
              {
                heading: 'Summary',
                claims: [
                  {
                    text: 'A grievance was raised.',
                    citations: [
                      { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                    ],
                  },
                ],
              },
            ],
          },
        },
        History: {
          input: {
            status: 'generated',
            sections: [
              {
                heading: 'History',
                claims: [
                  {
                    text: 'A fabricated dismissal outcome.',
                    citations: [
                      { sourceId: 'P2', quote: 'this exact quote is in no source at all' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const doc = await generateDocument(llm, CTX, baseReq({ sections: TWO_SECTIONS }));

    // The miss: History was scoped away from P2.
    expect(userMessageFor('History')!).not.toContain('upheld the complaint');
    // The ungroundable History claim is dropped → History gaps; nothing fabricated
    // reaches output.
    expect(doc.sections.find((s) => s.heading === 'History')!.gap).toBe(true);
    expect(doc.body).not.toContain('fabricated dismissal');
    expect(doc.droppedClaims).toBe(1);
    // Summary is unharmed by the miss.
    expect(doc.status).toBe('generated');
    expect(doc.sections.find((s) => s.heading === 'Summary')!.gap).toBe(false);
  });

  it('right-sizes models: CHEAP model for routing, the generation (Sonnet default) model for writing', async () => {
    const { llm, routeModel, sectionModels } = routingAwareLLM({
      routing: { P1: [1], P2: [2] },
      byHeading: {
        Summary: {
          input: {
            status: 'generated',
            sections: [
              {
                heading: 'Summary',
                claims: [
                  {
                    text: 'A grievance was raised.',
                    citations: [
                      { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                    ],
                  },
                ],
              },
            ],
          },
        },
        History: { input: { status: 'no_evidence', sections: [] } },
      },
    });
    await generateDocument(llm, CTX, baseReq({ sections: TWO_SECTIONS }));
    expect(routeModel()).toContain('haiku'); // routing is cheap
    expect(sectionModels().length).toBe(2);
    // Writing uses the generation default (Sonnet now — Opus not enabled on the
    // Bedrock account; GENERATION_MODEL selects it). The point stands: writing is
    // a distinct, higher tier than the cheap routing model.
    for (const m of sectionModels()) {
      expect(m).toContain('sonnet');
      expect(m).not.toContain('haiku');
    }
  });

  it('falls back to the FULL source set per section when routing yields nothing (never under-grounds)', async () => {
    // A router that returns no routing tool → no narrowing; every section sees
    // every source, exactly as before Move 1. Generation is never blocked on the
    // cheap pre-step.
    const captured = new Map<string, string>();
    let routeCalls = 0;
    const llm: LLMProvider = {
      id: 'fake',
      capabilities: CAPS,
      defaultModel: 'claude-opus-4-7',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        const userText =
          typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
        if (req.toolChoice?.name === SECTION_RELEVANCE_TOOL_NAME) {
          routeCalls += 1;
          return {
            text: '',
            toolCalls: [], // no routing → fall back to the full set
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            modelId: 'h',
            stopReason: 'tool_use',
          };
        }
        const heading = userText.match(/<section heading="([^"]*)"/)?.[1] ?? '';
        captured.set(heading, userText);
        return {
          text: '',
          toolCalls: [
            {
              id: 's',
              name: GENERATION_TOOL_NAME,
              input: { status: 'generated', sections: [{ heading, claims: [] }] },
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
    await generateDocument(llm, CTX, baseReq({ sections: TWO_SECTIONS }));
    expect(routeCalls).toBe(1);
    for (const heading of ['Summary', 'History']) {
      const msg = captured.get(heading)!;
      expect(msg).toContain('workload'); // P1
      expect(msg).toContain('upheld the complaint'); // P2 — full set delivered
    }
  });

  it('makes NO routing call for a single-section document (nothing to narrow)', async () => {
    let routeCalls = 0;
    const llm: LLMProvider = {
      id: 'fake',
      capabilities: CAPS,
      defaultModel: 'claude-opus-4-7',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        if (req.toolChoice?.name === SECTION_RELEVANCE_TOOL_NAME) routeCalls += 1;
        return {
          text: '',
          toolCalls: [
            {
              id: 's',
              name: GENERATION_TOOL_NAME,
              input: {
                status: 'generated',
                sections: [
                  {
                    heading: 'Summary',
                    claims: [
                      {
                        text: 'A grievance was raised.',
                        citations: [
                          { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
                        ],
                      },
                    ],
                  },
                ],
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
    const doc = await generateDocument(llm, CTX, baseReq()); // default: one section
    expect(routeCalls).toBe(0);
    expect(doc.status).toBe('generated');
  });

  it('scopeSourcesToSections:false sends every source to every section and makes NO routing call', async () => {
    const captured = new Map<string, string>();
    let routeCalls = 0;
    const llm: LLMProvider = {
      id: 'fake',
      capabilities: CAPS,
      defaultModel: 'claude-opus-4-7',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        const userText =
          typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
        if (req.toolChoice?.name === SECTION_RELEVANCE_TOOL_NAME) {
          routeCalls += 1;
          return {
            text: '',
            toolCalls: [],
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            modelId: 'h',
            stopReason: 'tool_use',
          };
        }
        const heading = userText.match(/<section heading="([^"]*)"/)?.[1] ?? '';
        captured.set(heading, userText);
        return {
          text: '',
          toolCalls: [
            {
              id: 's',
              name: GENERATION_TOOL_NAME,
              input: { status: 'generated', sections: [{ heading, claims: [] }] },
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
    await generateDocument(
      llm,
      CTX,
      baseReq({ sections: TWO_SECTIONS, scopeSourcesToSections: false }),
    );
    expect(routeCalls).toBe(0); // opt-out: no pre-step at all
    for (const heading of ['Summary', 'History']) {
      const msg = captured.get(heading)!;
      expect(msg).toContain('workload');
      expect(msg).toContain('upheld the complaint');
    }
  });
});

describe('generateDocument — completeness-honesty (D2)', () => {
  it('marks the document complete when the gather was complete (no banner)', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Helena Voss raised a grievance on 3 March about workload.',
              citations: [{ sourceId: 'P1', quote: 'raised a grievance' }],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(
      llm,
      CTX,
      baseReq({ completeness: { mayHaveUnlinkedRecords: false, recordCount: 2 } }),
    );
    expect(doc.completeness.complete).toBe(true);
    expect(doc.completeness.note).toBeNull();
  });

  it('surfaces the completeness banner when the gather flagged unlinked records', async () => {
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Helena Voss raised a grievance on 3 March about workload.',
              citations: [{ sourceId: 'P1', quote: 'raised a grievance' }],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(
      llm,
      CTX,
      baseReq({ completeness: { mayHaveUnlinkedRecords: true, recordCount: 2 } }),
    );
    expect(doc.completeness.complete).toBe(false);
    expect(doc.completeness.recordCount).toBe(2);
    expect(doc.completeness.note).toContain('2 records');
    expect(doc.completeness.note).toContain('could not be linked');
  });
});

describe('generateDocument — prompt hygiene (cache-safety + permission shape)', () => {
  it('marks the cacheable prefix and keeps tenant source text OUT of the system/tools', async () => {
    const SECRET = 'CONFIDENTIAL_SOURCE_TEXT_marker_42';
    const sources: GenerationSource[] = [{ sourceId: 'P1', paragraph: para('01', SECRET) }];
    const { llm, captured } = fakeLLM({
      status: 'generated',
      sections: [
        { heading: 'Summary', claims: [{ text: 'A claim.', sourceId: 'P1', quote: SECRET }] },
      ],
    });
    await generateDocument(llm, CTX, baseReq({ sources }));
    const req = captured()!;
    expect(req.cacheableSystemPrefix).toBe(true);
    expect(req.system).not.toContain(SECRET);
    expect(JSON.stringify(req.tools)).not.toContain(SECRET);
    // The source text rides in the user message (its data context).
    expect(req.messages[0]!.content).toContain(SECRET);
  });

  it('can only cite paragraphs in the passed (already-permission-filtered) source set', async () => {
    // The model "tries" to cite an id outside the caller's gathered set → dropped.
    const { llm } = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Visible claim.',
              citations: [
                { sourceId: 'P1', quote: 'raised a grievance on 3 March about workload' },
              ],
            },
            {
              text: 'Hidden-source claim.',
              citations: [{ sourceId: 'P_SECRET', quote: 'anything' }],
            },
          ],
        },
      ],
    });
    const doc = await generateDocument(llm, CTX, baseReq());
    expect(doc.citations).toHaveLength(1);
    expect(doc.citations[0]!.paragraphId).toBe(SOURCES[0]!.paragraph.id);
    expect(doc.droppedClaims).toBe(1);
  });
});

describe('generateDocument — cost telemetry', () => {
  it("records its llm_calls under purpose 'generation', not 'other'", async () => {
    // Regression guard for the cost-meter bug: generation spend was logged as
    // 'other', hiding it from cost analysis. The StubLLMProvider records a real
    // llm_calls row (region 'stub') via the graphStore, carrying ctx.purpose, so
    // we can assert the purpose the generation path attributes its spend to.
    const recorded: NewLlmCall[] = [];
    const capturingStore = {
      async insertLlmCall(_ctx: unknown, params: NewLlmCall): Promise<void> {
        recorded.push(params);
      },
    } as unknown as GraphStoreWriter;

    const ctx: ProviderCallContext = {
      tenantId: TENANT,
      purpose: 'generation',
      graphStore: capturingStore,
    };

    await generateDocument(new StubLLMProvider(), ctx, baseReq());

    expect(recorded.length).toBeGreaterThan(0);
    for (const call of recorded) {
      expect(call.purpose).toBe('generation');
    }
  });
});

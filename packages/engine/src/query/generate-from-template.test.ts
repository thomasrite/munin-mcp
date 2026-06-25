// M2.2 template executor — unit tests. A scriptable fake LLMProvider drives the
// auto sections; the tests assert the provenance-class STRUCTURE (refinement 1),
// that auto sections reuse M2.1 grounding, and that static/asked content is
// rendered as the author's/user's, never as a cited Munin fact (D3).

import { describe, expect, it } from 'vitest';

import type { DocumentTemplate } from '@muninhq/shared';
import { type Paragraph, asActorId, asDocumentId, asParagraphId, asTenantId } from '../graph/types';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallContext,
  ProviderCapabilities,
} from '../providers';
import type { GenerationSource } from './generate';
import { type TemplateGenerateRequest, generateFromTemplate } from './generate-from-template';
import { GENERATION_TOOL_NAME } from './generation-prompt';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const ACTOR = asActorId('tpl-test');
const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};
const CTX: ProviderCallContext = { tenantId: TENANT, purpose: 'other', graphStore: {} as never };

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

function fakeLLM(documentInput: unknown): LLMProvider {
  return {
    id: 'fake',
    capabilities: CAPS,
    defaultModel: 'claude-opus-4-7',
    async complete(_req: LLMRequest): Promise<LLMResponse> {
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
      };
    },
  };
}

const SOURCES: GenerationSource[] = [
  {
    sourceId: 'P1',
    paragraph: para('01', 'Helena Voss raised a grievance on 3 March about workload.'),
  },
];

// A template mixing all three fill kinds — the realistic regulated-artefact shape.
const TEMPLATE: DocumentTemplate = {
  id: 'hr-case-summary',
  title: 'HR case summary',
  subjectEntityType: 'Employee',
  sections: [
    {
      heading: 'Letterhead',
      format: 'prose',
      fill: { kind: 'static', text: 'CONFIDENTIAL — HR record' },
    },
    {
      heading: 'Summary',
      format: 'prose',
      fill: { kind: 'auto-from-gather', instruction: 'Summarise the records.' },
    },
    {
      heading: 'Decision',
      format: 'field',
      fill: { kind: 'asked-of-user', slot: { kind: 'text', required: true } },
    },
  ],
};

function req(overrides: Partial<TemplateGenerateRequest> = {}): TemplateGenerateRequest {
  return {
    template: TEMPLATE,
    subject: 'Helena Voss',
    sources: SOURCES,
    completeness: { mayHaveUnlinkedRecords: false, recordCount: 1 },
    ...overrides,
  };
}

describe('generateFromTemplate — provenance classes (D3 / refinement 1)', () => {
  it('tags each section by provenance class in the OUTPUT STRUCTURE', async () => {
    const llm = fakeLLM({
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
    const doc = await generateFromTemplate(
      llm,
      CTX,
      req({ slotValues: { Decision: 'Upheld in part.' } }),
    );

    expect(doc.sections.map((s) => s.kind)).toEqual(['static', 'munin-asserted', 'asked-of-user']);

    const stat = doc.sections[0]!;
    expect(stat.kind).toBe('static');
    if (stat.kind === 'static') expect(stat.text).toBe('CONFIDENTIAL — HR record');

    const auto = doc.sections[1]!;
    expect(auto.kind).toBe('munin-asserted');
    if (auto.kind === 'munin-asserted') {
      expect(auto.gap).toBe(false);
      expect(auto.claims[0]!.text).toBe('A grievance was raised.');
      expect(auto.claims[0]!.markers).toEqual([1]);
    }

    const asked = doc.sections[2]!;
    expect(asked.kind).toBe('asked-of-user');
    if (asked.kind === 'asked-of-user') {
      expect(asked.provided).toBe(true);
      expect(asked.value).toBe('Upheld in part.');
    }

    // Only the auto (Munin-asserted) content carries citations.
    expect(doc.citations).toHaveLength(1);
    expect(doc.groundedClaimCount).toBe(1);
    expect(doc.status).toBe('generated');
  });

  it('static/asked content is NOT a cited Munin fact (no citations attach to them)', async () => {
    const llm = fakeLLM({ status: 'no_evidence', sections: [] }); // auto grounds nothing
    const doc = await generateFromTemplate(
      llm,
      CTX,
      req({ slotValues: { Decision: 'Dismissed.' } }),
    );
    // The document still exists (boilerplate + user input), but asserts NO cited
    // Munin facts: zero citations, the auto section is a gap.
    expect(doc.status).toBe('generated');
    expect(doc.citations).toHaveLength(0);
    const auto = doc.sections.find((s) => s.kind === 'munin-asserted')!;
    if (auto.kind === 'munin-asserted') expect(auto.gap).toBe(true);
  });

  it('a required asked-of-user section with no value renders as a gap (never invented)', async () => {
    const llm = fakeLLM({
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
    const doc = await generateFromTemplate(llm, CTX, req()); // no slotValues
    const asked = doc.sections.find((s) => s.kind === 'asked-of-user')!;
    if (asked.kind === 'asked-of-user') {
      expect(asked.provided).toBe(false);
      expect(asked.value).toBeNull();
    }
    expect(doc.body).toContain('to be completed');
  });
});

describe('generateFromTemplate — grounding + completeness inherited from M2.1', () => {
  it('an ungrounded auto claim is dropped (fail-closed carries through the executor)', async () => {
    const llm = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'Fabricated dismissal.',
              citations: [{ sourceId: 'P1', quote: 'dismissed for gross misconduct' }],
            },
          ],
        },
      ],
    });
    const doc = await generateFromTemplate(llm, CTX, req({ slotValues: { Decision: 'x' } }));
    expect(doc.citations).toHaveLength(0);
    expect(doc.droppedClaims).toBe(1);
    expect(doc.body).not.toContain('dismissal');
  });

  it('surfaces the completeness banner when the gather flagged unlinked records', async () => {
    const llm = fakeLLM({
      status: 'generated',
      sections: [
        {
          heading: 'Summary',
          claims: [
            {
              text: 'A grievance was raised.',
              citations: [{ sourceId: 'P1', quote: 'raised a grievance' }],
            },
          ],
        },
      ],
    });
    const doc = await generateFromTemplate(
      llm,
      CTX,
      req({ completeness: { mayHaveUnlinkedRecords: true, recordCount: 1 } }),
    );
    expect(doc.completeness.complete).toBe(false);
    expect(doc.completeness.note).toContain('could not be linked');
  });

  it('a template with no auto sections never calls the model', async () => {
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
    const staticOnly: DocumentTemplate = {
      id: 't',
      title: 't',
      subjectEntityType: 'Employee',
      sections: [
        { heading: 'Boilerplate', format: 'prose', fill: { kind: 'static', text: 'Hello.' } },
      ],
    };
    const doc = await generateFromTemplate(llm, CTX, req({ template: staticOnly }));
    expect(called).toBe(false);
    expect(doc.status).toBe('generated');
    expect(doc.sections[0]!.kind).toBe('static');
  });
});

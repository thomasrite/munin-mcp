import { describe, expect, it } from 'vitest';

import type { GraphStoreWriter } from '../graph/graph-store';
import { asDocumentId, asParagraphId, asTenantId } from '../graph/types';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderCapabilities } from '../providers';
import { QueryAuditor, extractClaim } from './query-auditor';
import type { QueryResult } from './types';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const PARA = asParagraphId('00000000-0000-0000-0000-000000000011');
const DOC = asDocumentId('00000000-0000-0000-0000-0000000000dd');

const CAPS: ProviderCapabilities = {
  promptCaching: true,
  asymmetricEmbeddings: false,
  maxInputTokens: 100000,
  maxBatchSize: 100,
};

// Stub LLM: verdict scripted per call (true/false), counts calls.
function auditLlm(verdicts: readonly boolean[]): { provider: LLMProvider; calls: () => number } {
  let i = 0;
  const provider: LLMProvider = {
    id: 'stub',
    capabilities: CAPS,
    defaultModel: 'claude-sonnet-4-6',
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      const supported = verdicts[i] ?? false;
      i += 1;
      return {
        text: '',
        toolCalls: [
          {
            id: `a${i}`,
            name: 'submit_faithfulness_verdict',
            input: { supported, reason: supported ? 'stated in source' : 'not in source' },
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
  return { provider, calls: () => i };
}

const fakeStore = {} as unknown as GraphStoreWriter;

function answered(citations: QueryResult['citations'], answer = 'A [1] and B [2].'): QueryResult {
  return { status: 'answered', answer, citations };
}

describe('extractClaim', () => {
  it('isolates the claim carrying the marker across sentences', () => {
    expect(extractClaim('Apollo ships in Q3 [1]. Jones leads it [2].', 2)).toBe(
      'Jones leads it [2]',
    );
  });

  it('isolates ONE claim per citation in a compound, multi-citation sentence', () => {
    const answer =
      'The hearing was held on 29 January [1], concerned two elements [2], and was upheld [3].';
    expect(extractClaim(answer, 1)).toBe('The hearing was held on 29 January [1]');
    expect(extractClaim(answer, 2)).toBe('concerned two elements [2]');
    expect(extractClaim(answer, 3)).toBe('and was upheld [3]');
  });

  it('walks adjacent markers back to their shared claim', () => {
    // "[1][2]" and "[1], [2]" both cite the same preceding claim — neither may
    // resolve to an empty "[2]".
    expect(extractClaim('Two stress-related absences were recorded [1][2].', 2)).toBe(
      'Two stress-related absences were recorded [1][2]',
    );
    expect(extractClaim('Thomas Reedy is the Site Manager [1], [2].', 2)).toBe(
      'Thomas Reedy is the Site Manager [1], [2]',
    );
  });

  it('attaches a marker standing alone after a terminator to the preceding sentence', () => {
    // Regression: must NOT return a bare "[1]" with no content for the judge.
    expect(extractClaim('The grievance was partially upheld. [1]', 1)).toBe(
      'The grievance was partially upheld. [1]',
    );
  });

  it('falls back to the whole answer when the marker is not found', () => {
    expect(extractClaim('No markers here.', 5)).toBe('No markers here.');
  });
});

describe('QueryAuditor', () => {
  it('returns a null score for a no_evidence result and makes no call', async () => {
    const { provider, calls } = auditLlm([]);
    const auditor = new QueryAuditor({ llmProvider: provider, graphStore: fakeStore });
    const r = await auditor.audit({
      tenantId: TENANT,
      question: 'q',
      result: { status: 'no_evidence', answer: 'x', citations: [] },
      paragraphText: new Map(),
    });
    expect(r.faithfulnessScore).toBeNull();
    expect(calls()).toBe(0);
  });

  it('scores a supported citation as faithful', async () => {
    const { provider } = auditLlm([true]);
    const auditor = new QueryAuditor({ llmProvider: provider, graphStore: fakeStore });
    const r = await auditor.audit({
      tenantId: TENANT,
      question: 'q',
      result: answered(
        [{ marker: 1, paragraphId: PARA, documentId: DOC, quote: 'x' }],
        'Claim [1].',
      ),
      paragraphText: new Map([[PARA, 'the supporting source text']]),
    });
    expect(r.faithfulnessScore).toBe(1);
    expect(r.verdicts[0]!.supported).toBe(true);
  });

  it('scores a mix and reports the fraction supported', async () => {
    const { provider } = auditLlm([true, false]);
    const auditor = new QueryAuditor({ llmProvider: provider, graphStore: fakeStore });
    const r = await auditor.audit({
      tenantId: TENANT,
      question: 'q',
      result: answered([
        { marker: 1, paragraphId: PARA, documentId: DOC, quote: 'x' },
        { marker: 2, paragraphId: PARA, documentId: DOC, quote: 'y' },
      ]),
      paragraphText: new Map([[PARA, 'source text']]),
    });
    expect(r.faithfulnessScore).toBe(0.5);
  });

  it('marks a citation unsupported when no source text is supplied', async () => {
    const { provider, calls } = auditLlm([true]);
    const auditor = new QueryAuditor({ llmProvider: provider, graphStore: fakeStore });
    const r = await auditor.audit({
      tenantId: TENANT,
      question: 'q',
      result: answered(
        [{ marker: 1, paragraphId: PARA, documentId: DOC, quote: 'x' }],
        'Claim [1].',
      ),
      paragraphText: new Map(), // no text for PARA
    });
    expect(r.verdicts[0]!.supported).toBe(false);
    expect(calls()).toBe(0); // never reaches the model
  });
});

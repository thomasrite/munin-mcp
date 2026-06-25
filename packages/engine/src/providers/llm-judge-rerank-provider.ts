// LLM-judge reranker — a RerankProvider that re-scores candidates with a small,
// fast LLM (Haiku by default). GENERIC: it composes the existing LLMProvider
// interface and imports no external SDK, so it works against any LLM backend
// (Bedrock Claude in production — UK-hosted, eu-west-2). The fallback when a
// purpose-built cross-encoder (Cohere Rerank) is not enabled on the account.
//
// It re-orders ONLY the candidate documents handed to it (already retrieved and
// permission-filtered by the caller); it never fetches anything, so it cannot
// surface a document outside the caller's permissions.

import type {
  LLMProvider,
  LLMTool,
  ProviderCallContext,
  RerankProvider,
  RerankRequest,
  RerankResponse,
  RerankResult,
} from './provider-types';

const RANK_TOOL: LLMTool = {
  name: 'rank',
  description:
    'Return the passage numbers that are genuinely relevant to the query, most relevant first.',
  inputSchema: {
    type: 'object',
    properties: {
      ranking: {
        type: 'array',
        description: 'Passage numbers ordered most-relevant first. Omit irrelevant passages.',
        items: { type: 'integer' },
      },
    },
    required: ['ranking'],
    additionalProperties: false,
  },
};

const SYSTEM =
  'You are a precise search reranker. Given a QUERY and a numbered list of PASSAGES, decide ' +
  'which passages genuinely answer the query. Pay close attention to SPECIFIC identifiers — ' +
  'personal names, reference codes, dates and the particular entity the query is about — not ' +
  'just topical similarity: many passages may be on the same topic but about a different person ' +
  'or case. Call the rank tool with the passage numbers ordered most-relevant first; omit ' +
  'passages that are not genuinely relevant.';

// Keep each candidate compact so a wide pool fits one prompt.
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface LlmJudgeRerankConfig {
  readonly llm: LLMProvider;
  // Cheap model id for the judging call (default Haiku).
  readonly model?: string;
  // Max candidates re-scored in one call (prompt-size bound).
  readonly maxDocuments?: number;
  readonly perDocChars?: number;
}

export class LlmJudgeRerankProvider implements RerankProvider {
  readonly id = 'llm-judge';
  readonly modelId: string;
  readonly maxDocuments: number;
  private readonly llm: LLMProvider;
  private readonly perDocChars: number;

  constructor(config: LlmJudgeRerankConfig) {
    this.llm = config.llm;
    this.modelId = config.model ?? 'claude-haiku-4-5-20251001';
    this.maxDocuments = config.maxDocuments ?? 60;
    this.perDocChars = config.perDocChars ?? 500;
  }

  async rerank(request: RerankRequest, ctx: ProviderCallContext): Promise<RerankResponse> {
    const docs = request.documents.slice(0, this.maxDocuments);
    if (docs.length === 0) return { ranking: [], modelId: this.modelId };

    const numbered = docs
      .map((d, i) => `[${i}] ${truncate(d.text.replace(/\s+/g, ' ').trim(), this.perDocChars)}`)
      .join('\n\n');
    const user = `QUERY: ${request.query}\n\nPASSAGES:\n${numbered}`;

    const response = await this.llm.complete(
      {
        model: this.modelId,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
        tools: [RANK_TOOL],
        toolChoice: { type: 'tool', name: RANK_TOOL.name },
        maxOutputTokens: 512,
      },
      ctx,
    );

    const call = response.toolCalls.find((c) => c.name === RANK_TOOL.name);
    const raw = call?.input.ranking;
    const order = Array.isArray(raw) ? raw : [];

    const ranking: RerankResult[] = [];
    const seen = new Set<number>();
    // Score is the descending rank position (higher = better), used only to order.
    let score = order.length;
    for (const value of order) {
      const idx = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(idx) || idx < 0 || idx >= docs.length || seen.has(idx)) continue;
      seen.add(idx);
      const doc = docs[idx];
      if (doc) ranking.push({ id: doc.id, score: score });
      score -= 1;
      if (ranking.length >= request.topK) break;
    }
    return { ranking, modelId: this.modelId };
  }
}

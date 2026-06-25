// Stub providers — zero external spend.
//
// Selected via `LLM_PROVIDER=stub` / `EMBEDDING_PROVIDER=stub` for pure-UI
// development sessions (auth, dashboard layout, document-viewer styling) that
// do not test real query/extraction behaviour. They implement the full
// provider interfaces, import no provider SDK, and still write `llm_calls`
// telemetry (with a `stub` region + `stub-*` model ids) so the cost-reporting
// path is exercised and stub usage is distinguishable from real spend.
//
// The LLM stub detects which structured tool the caller forced by inspecting
// the tool's JSON-Schema `properties` (not by tool-name constants), so it stays
// decoupled from the extract/query layers:
//   - a tool whose schema has `entities` → extraction: returns an empty,
//     schema-valid extraction (extracts nothing — safe for UI sessions).
//   - a tool whose schema has `citations` → answer synthesis: echoes the first
//     <source> in the prompt as a grounded citation so the chat UI renders a
//     valid cited answer without any real model call.

import { asActorId } from '../graph/types';
import type {
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMTool,
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';

const STUB_DIMENSIONS = 1024;
const STUB_CAPS: ProviderCapabilities = {
  promptCaching: false,
  asymmetricEmbeddings: false,
  maxInputTokens: 200_000,
  maxBatchSize: 256,
};

// A constant unit vector. Identical for every input, so search is deterministic
// (and meaningless) — fine for UI sessions that don't test retrieval quality.
const CONSTANT_VECTOR: readonly number[] = new Array<number>(STUB_DIMENSIONS).fill(
  1 / Math.sqrt(STUB_DIMENSIONS),
);

// Write the same telemetry shape the real providers do, marked as stub.
async function recordStubCall(
  ctx: ProviderCallContext,
  modelId: string,
  purpose: ProviderCallContext['purpose'],
): Promise<void> {
  await ctx.graphStore.insertLlmCall(
    { tenantId: ctx.tenantId, actor: asActorId('stub-provider') },
    {
      purpose,
      modelId,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      region: 'stub',
      ...(ctx.extractorVersionId !== undefined
        ? { extractorVersionId: ctx.extractorVersionId }
        : {}),
      ...(ctx.documentId !== undefined ? { documentId: ctx.documentId } : {}),
    },
  );
}

function schemaProperties(tool: LLMTool | undefined): readonly string[] {
  if (!tool) return [];
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return schema.properties ? Object.keys(schema.properties) : [];
}

// Parse the first `<source id="...">\n<text>\n</source>` block and return a
// short verbatim quote from it, so the citation passes hot-path quote-grounding.
function firstSourceQuote(message: string): { sourceId: string; quote: string } | null {
  const m = message.match(/<source id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/source>/);
  if (!m?.[1] || !m[2]) return null;
  const quote = m[2].trim().split(/\s+/).slice(0, 6).join(' ');
  return { sourceId: m[1], quote };
}

const STUB_LLM_MODEL = 'stub-llm-model';
const STUB_EMBED_MODEL = 'stub-embed-model';

export class StubLLMProvider implements LLMProvider {
  readonly id = 'stub-llm';
  readonly capabilities = STUB_CAPS;
  readonly defaultModel = STUB_LLM_MODEL;

  async complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    // Record the model the caller asked for (so MUNIN_DEV_MODE=haiku's forced
    // model is observable in llm_calls.model_id), falling back to the stub's
    // own id when no per-call model was set. region stays 'stub' regardless, so
    // stub usage is always distinguishable from real spend.
    await recordStubCall(ctx, request.model ?? STUB_LLM_MODEL, ctx.purpose);

    const forced = request.tools?.find((t) => t.name === request.toolChoice?.name);
    const tool = forced ?? request.tools?.[0];
    const props = schemaProperties(tool);

    if (tool && props.includes('entities')) {
      // Extraction tool: extract nothing (schema-valid, safe for UI sessions).
      return toolResponse(tool.name, { entities: [], relationships: [] });
    }

    if (tool && props.includes('citations')) {
      // Answer tool: echo the first source as a grounded citation, or decline.
      const userMessage = request.messages.map((m) => m.content).join('\n');
      const source = firstSourceQuote(userMessage);
      if (!source) {
        return toolResponse(tool.name, {
          status: 'no_evidence',
          answer: 'No evidence is available (stub provider).',
          citations: [],
        });
      }
      return toolResponse(tool.name, {
        status: 'answered',
        answer: 'Stubbed answer grounded in the first source [1].',
        citations: [{ marker: 1, sourceId: source.sourceId, quote: source.quote }],
      });
    }

    // No tool forced: a plain text reply.
    return {
      text: 'Stubbed response (no real model called).',
      toolCalls: [],
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      modelId: STUB_LLM_MODEL,
      stopReason: 'end_turn',
    };
  }
}

function toolResponse(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    text: '',
    toolCalls: [{ id: 'stub-tool-call', name, input }],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    modelId: STUB_LLM_MODEL,
    stopReason: 'tool_use',
  };
}

export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'stub-embed';
  readonly capabilities = STUB_CAPS;
  readonly dimensions = STUB_DIMENSIONS;
  readonly modelId = STUB_EMBED_MODEL;

  async embed(request: EmbedRequest, ctx: ProviderCallContext): Promise<EmbedResponse> {
    await recordStubCall(ctx, STUB_EMBED_MODEL, 'embedding');
    return {
      vectors: request.texts.map(() => CONSTANT_VECTOR),
      inputTokens: 0,
      modelId: STUB_EMBED_MODEL,
    };
  }
}

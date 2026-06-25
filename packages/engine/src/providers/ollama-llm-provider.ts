// Ollama LLM provider for the local/desktop runtime (P1).
//
// This file (with ollama-embedding-provider.ts) is the ONLY place Ollama is
// called — raw `fetch`, no SDK. It talks to a LOCAL Ollama daemon (default
// http://localhost:11434), so there is zero external network egress. Cost
// telemetry is recorded honestly with region 'local' (distinct from 'stub' and
// from the cloud regions), so local usage is distinguishable in `llm_calls`.
//
// Cache-safety (F4): Ollama has no prompt cache, so `cacheableSystemPrefix` is
// ignored. Tenant content already lives in the user message (never a cacheable
// prefix), so the cache-safety invariant holds STRUCTURALLY — there is no cache
// for tenant content to leak into.
//
// A weak local model may not support tool-calling, or may decline to answer.
// That surfaces as an empty toolCalls array, which the query/extraction paths
// already handle as a fail-closed `no_evidence` / honest skip — correct
// behaviour for a local tier, not a bug.

import { asActorId } from '../graph/types';
import { ProviderError, ProviderUnavailableError } from './provider-errors';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  ProviderCallContext,
  ProviderCapabilities,
} from './provider-types';

const PROVIDER_ID = 'ollama';
const REGION = 'local';
const ACTOR = asActorId('provider:ollama');

export interface OllamaLLMProviderConfig {
  readonly baseUrl: string; // e.g. http://localhost:11434
  readonly defaultModel: string; // a locally-pulled chat model
  readonly fetchImpl?: typeof fetch; // injected for tests
  // Per-request budget (P2-10). Local CPU generation is legitimately slow, so
  // the default is generous — but a wedged daemon must fail fast, not hang
  // the pipeline forever. Overridable via OLLAMA_TIMEOUT_MS (factory-wired).
  readonly timeoutMs?: number;
}

export const DEFAULT_OLLAMA_LLM_TIMEOUT_MS = 120_000;

interface OllamaChatResponse {
  readonly model?: string;
  readonly message?: {
    readonly content?: string;
    readonly tool_calls?: ReadonlyArray<{
      readonly function?: { readonly name?: string; readonly arguments?: unknown };
    }>;
  };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly done_reason?: string;
}

export class OllamaLLMProvider implements LLMProvider {
  readonly id = PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    promptCaching: false,
    asymmetricEmbeddings: false,
    // Conservative; the real ceiling is the local model's context window.
    maxInputTokens: 32768,
    maxBatchSize: 1,
  };
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: OllamaLLMProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_OLLAMA_LLM_TIMEOUT_MS;
  }

  async complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel;
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {}),
      },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const startedAt = Date.now();
    let data: OllamaChatResponse;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ProviderError(
          PROVIDER_ID,
          `/api/chat HTTP ${res.status}: ${detail.slice(0, 300)}`,
        );
      }
      data = (await res.json()) as OllamaChatResponse;
    } catch (err) {
      await this.record(ctx, model, ctx.purpose, 0, 0, Date.now() - startedAt, true).catch(
        () => {},
      );
      throw asProviderError(err, this.timeoutMs);
    }

    const text = data.message?.content ?? '';
    const toolCalls: LLMToolCall[] = (data.message?.tool_calls ?? [])
      .map((tc, i): LLMToolCall | null => {
        const name = tc.function?.name;
        if (!name) return null;
        const args = tc.function?.arguments;
        const input =
          typeof args === 'string'
            ? safeParseObject(args)
            : ((args as Record<string, unknown> | undefined) ?? {});
        return { id: `ollama-${i}`, name, input };
      })
      .filter((x): x is LLMToolCall => x !== null);

    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    await this.record(
      ctx,
      model,
      ctx.purpose,
      inputTokens,
      outputTokens,
      Date.now() - startedAt,
      false,
    );

    return {
      text,
      toolCalls,
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      modelId: data.model ?? model,
      stopReason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(data.done_reason),
    };
  }

  private async record(
    ctx: ProviderCallContext,
    modelId: string,
    purpose: ProviderCallContext['purpose'],
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    failed: boolean,
  ): Promise<void> {
    await ctx.graphStore.insertLlmCall(
      { tenantId: ctx.tenantId, actor: ACTOR },
      {
        purpose,
        modelId,
        inputTokens,
        cachedInputTokens: 0,
        outputTokens,
        latencyMs,
        region: REGION,
        ...(failed ? { failed: true } : {}),
        ...(ctx.extractorVersionId !== undefined
          ? { extractorVersionId: ctx.extractorVersionId }
          : {}),
        ...(ctx.documentId !== undefined ? { documentId: ctx.documentId } : {}),
      },
    );
  }
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapStopReason(reason: string | undefined): LLMResponse['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

// A failed fetch to a local daemon is almost always "Ollama isn't running" —
// surface it as ProviderUnavailableError; pass through our own ProviderErrors.
// A TIMEOUT (AbortSignal.timeout fired — P2-10) is named explicitly so a
// wedged daemon reads as "wedged", not "not running".
function asProviderError(err: unknown, timeoutMs: number): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new ProviderError(
      PROVIDER_ID,
      `/api/chat timed out after ${timeoutMs}ms — the Ollama daemon is up but not responding (wedged or overloaded). Raise OLLAMA_TIMEOUT_MS for slow local hardware.`,
    );
  }
  return new ProviderUnavailableError(PROVIDER_ID, err);
}

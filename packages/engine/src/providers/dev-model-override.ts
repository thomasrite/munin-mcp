// Dev-mode model override.
//
// `MUNIN_DEV_MODE=haiku` routes every LLM call through Haiku 4.5 instead of the
// production defaults (Sonnet for extraction, Opus for answer synthesis). It is
// implemented as a decorator around the selected LLMProvider so a single
// chokepoint covers BOTH paths — including the query pipeline's hard-coded
// answer model, which sets `request.model` explicitly. The decorator forces
// `model` on every request, so any per-call model is overridden in dev.
//
// Flip the env var off (and re-run) for end-of-session answer-quality
// verification or any answer-sensitive work.

import type { LLMProvider, LLMRequest, LLMResponse, ProviderCallContext } from './provider-types';

export const DEV_HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Wrap a provider so every request is forced to `model`, regardless of any
// per-call override the caller supplied.
export function withForcedModel(inner: LLMProvider, model: string): LLMProvider {
  return {
    id: `${inner.id}+forced(${model})`,
    capabilities: inner.capabilities,
    defaultModel: model,
    complete(request: LLMRequest, ctx: ProviderCallContext): Promise<LLMResponse> {
      return inner.complete({ ...request, model }, ctx);
    },
  };
}

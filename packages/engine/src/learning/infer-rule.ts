// inferRule (P5a) — infer ONE reusable style rule from a (draft → human-final)
// diff, on the cheap model.
//
// CACHE-SAFE: the static prompt (assembleRuleInferencePrompt) is the cacheable
// prefix; the draft + final ride ONLY in the user-turn message (render
// InferenceUserMessage), never the cached prefix — the same F4 invariant the
// generation/answer paths obey. The draft/final are treated as UNTRUSTED data.
//
// STYLE NOT CONTENT: the prompt forbids embedding any document-specific fact; the
// returned rule is a how-to-write preference, reusable across documents. inferRule
// returns null when the diff yields no reusable style signal ('no_rule') — an
// honest decline rather than a manufactured rule.
//
// GENERIC: no vertical concept, no provider SDK — the LLMProvider interface is the
// only model access. The cheap model is forced on the request (like the
// section-relevance router), so the caller's ctx model never escalates this.

import type { LLMProvider, ProviderCallContext } from '../providers';
import { RULE_INFERENCE_TOOL_NAME, assembleRuleInferencePrompt } from './rule-inference-prompt';

// The cheap model for inference — never an Opus/quality model. A model-id string
// is generic engine config (like SECTION_RELEVANCE_MODEL), no vertical concept.
export const RULE_INFERENCE_MODEL = 'claude-haiku-4-5-20251001';

// The inferred rule output tiny (one rule + a slug + a number). Ample headroom.
const RULE_INFERENCE_MAX_OUTPUT_TOKENS = 512;

export interface InferRuleInput {
  // The draft Munin generated and the version the human finalised.
  readonly draft: string;
  readonly final: string;
  // NON-CONTENT metadata (document/template id, etc.). Accepted for parity with
  // the feedback record, but DELIBERATELY NOT sent to the model: ids add nothing
  // to style inference and sending them would risk leaking document-specific
  // detail into a rule that must be document-agnostic.
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface InferredRule {
  // The abstract, reusable style rule (how to write). Opaque downstream.
  readonly ruleText: string;
  // Short lowercase KIND slug; the web derives the deterministic rule_key from it.
  readonly dimension: string;
  readonly confidence: number;
}

/**
 * Infer one reusable style rule from the (draft → final) diff, or null when there
 * is no reusable style signal (a pure content edit, or an unparseable/failed
 * response). Reads nothing; one cheap LLM call.
 */
export async function inferRule(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  input: InferRuleInput,
): Promise<InferredRule | null> {
  // No diff → no rule, without spending a call.
  if (input.draft.trim() === input.final.trim()) return null;

  const prompt = assembleRuleInferencePrompt();
  let response: Awaited<ReturnType<LLMProvider['complete']>>;
  try {
    response = await llm.complete(
      {
        model: RULE_INFERENCE_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: renderInferenceUserMessage(input) }],
        cacheableSystemPrefix: true,
        maxOutputTokens: RULE_INFERENCE_MAX_OUTPUT_TOKENS,
        tools: [prompt.tool],
        toolChoice: { type: 'tool', name: prompt.toolName },
      },
      ctx,
    );
  } catch {
    // Inference is best-effort — a provider failure must never break the capture
    // path (the feedback row is already recorded). Decline quietly.
    return null;
  }
  // A truncated tool call yields partial/unparseable JSON; treat as no rule.
  if (response.stopReason === 'max_tokens') return null;

  const call = response.toolCalls.find((c) => c.name === RULE_INFERENCE_TOOL_NAME);
  return call ? parseRule(call.input) : null;
}

// The inference user turn: the draft + final, angle-bracket-neutralised so neither
// can forge a tag. CARRIES TENANT CONTENT → never cacheable (the call's cacheable
// prefix is the static system/tool only).
function renderInferenceUserMessage(input: InferRuleInput): string {
  return [
    '<draft>',
    neutraliseAngleBrackets(input.draft),
    '</draft>',
    '',
    '<final>',
    neutraliseAngleBrackets(input.final),
    '</final>',
  ].join('\n');
}

function neutraliseAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Defensive parse (the tool schema already constrains the shape). Returns null on
// 'no_rule' or any malformed/empty field.
function parseRule(input: Readonly<Record<string, unknown>>): InferredRule | null {
  if (input.status !== 'rule') return null;
  const rule = input.rule;
  if (rule === null || typeof rule !== 'object') return null;
  const r = rule as Record<string, unknown>;
  const ruleText = typeof r.text === 'string' ? r.text.trim() : '';
  const dimension = typeof r.dimension === 'string' ? r.dimension.trim() : '';
  if (ruleText === '' || dimension === '') return null;
  const confidence =
    typeof r.confidence === 'number' && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0.5;
  return { ruleText, dimension, confidence };
}

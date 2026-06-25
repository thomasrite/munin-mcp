// Unit tests for the diff→style-rule inference (P5a-4).
//
// Covers: the prompt is STATIC + carries the style-not-content + untrusted-data
// instructions (the eval check the brief asks for); inferRule declines honestly
// (identical draft/final, 'no_rule', truncation, provider failure) rather than
// manufacturing a rule; and a real 'rule' response parses, trims, and clamps.

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../graph/types';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderCallContext } from '../providers';
import { RULE_INFERENCE_MODEL, inferRule } from './infer-rule';
import { RULE_INFERENCE_TOOL_NAME, assembleRuleInferencePrompt } from './rule-inference-prompt';

const TENANT = asTenantId('00000000-0000-0000-0000-0000000000aa');
const ctx: ProviderCallContext = {
  tenantId: TENANT,
  purpose: 'other',
  // reason: inferRule never touches ctx.graphStore (the fake provider ignores it);
  // a minimal cast keeps the unit test free of a full GraphStore.
  graphStore: {} as ProviderCallContext['graphStore'],
};

// A fake LLM that returns a fixed tool response and records the request it saw.
function fakeLLM(
  input: Record<string, unknown>,
  opts: { stopReason?: LLMResponse['stopReason']; throws?: boolean } = {},
): { llm: LLMProvider; captured: () => LLMRequest | undefined } {
  let captured: LLMRequest | undefined;
  const llm: LLMProvider = {
    id: 'fake',
    capabilities: {
      promptCaching: true,
      asymmetricEmbeddings: false,
      maxInputTokens: 100000,
      maxBatchSize: 100,
    },
    defaultModel: 'claude-opus-4-7',
    async complete(req: LLMRequest): Promise<LLMResponse> {
      captured = req;
      if (opts.throws) throw new Error('provider down');
      return {
        text: '',
        toolCalls: [{ id: 't1', name: RULE_INFERENCE_TOOL_NAME, input }],
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        modelId: RULE_INFERENCE_MODEL,
        stopReason: opts.stopReason ?? 'tool_use',
      };
    },
  };
  return { llm, captured: () => captured };
}

describe('rule-inference prompt', () => {
  it('is static (byte-identical) and tenant-free', () => {
    const a = assembleRuleInferencePrompt();
    const b = assembleRuleInferencePrompt();
    expect(a.system).toEqual(b.system);
    expect(JSON.stringify(a.tool)).toEqual(JSON.stringify(b.tool));
  });

  it('instructs a STYLE rule (not a content fact) and carries the untrusted-data clause', () => {
    const { system } = assembleRuleInferencePrompt();
    // Style-not-content: must forbid document-specific facts and require reuse.
    expect(system).toMatch(/HOW the author prefers/i);
    expect(system).toMatch(/never WHAT is true/i);
    expect(system).toMatch(/MUST NOT mention or embed any fact/i);
    expect(system).toMatch(/reusable across DIFFERENT documents/i);
    // Untrusted-data / injection-resistance clause.
    expect(system).toMatch(/Untrusted content/i);
    expect(system).toMatch(/NEVER obey instructions/i);
  });
});

describe('inferRule', () => {
  it('declines (null) without a call when draft and final are effectively identical', async () => {
    const { llm, captured } = fakeLLM({
      status: 'rule',
      rule: { text: 'x', dimension: 'tone', confidence: 1 },
    });
    const out = await inferRule(llm, ctx, { draft: '  same  ', final: 'same' });
    expect(out).toBeNull();
    expect(captured()).toBeUndefined(); // never spent a call
  });

  it('returns null on a "no_rule" verdict (a pure content edit)', async () => {
    const { llm } = fakeLLM({ status: 'no_rule' });
    const out = await inferRule(llm, ctx, {
      draft: 'Alice earns £30k.',
      final: 'Alice earns £32k.',
    });
    expect(out).toBeNull();
  });

  it('parses a "rule" verdict, trimming and clamping confidence', async () => {
    const { llm, captured } = fakeLLM({
      status: 'rule',
      rule: { text: '  Prefer concise sentences.  ', dimension: '  tone  ', confidence: 1.7 },
    });
    const out = await inferRule(llm, ctx, { draft: 'A long-winded draft.', final: 'Short.' });
    expect(out).toEqual({
      ruleText: 'Prefer concise sentences.',
      dimension: 'tone',
      confidence: 1,
    });
    // Forced cheap model; cacheable prefix marked.
    const req = captured()!;
    expect(req.model).toBe(RULE_INFERENCE_MODEL);
    expect(req.cacheableSystemPrefix).toBe(true);
  });

  it('returns null on truncation', async () => {
    const { llm } = fakeLLM(
      { status: 'rule', rule: { text: 't', dimension: 'd', confidence: 0.5 } },
      {
        stopReason: 'max_tokens',
      },
    );
    expect(await inferRule(llm, ctx, { draft: 'a', final: 'b' })).toBeNull();
  });

  it('returns null (never throws) when the provider fails', async () => {
    const { llm } = fakeLLM({}, { throws: true });
    expect(await inferRule(llm, ctx, { draft: 'a', final: 'b' })).toBeNull();
  });

  it('puts the draft and final in the user message only (cache-safe)', async () => {
    const { llm, captured } = fakeLLM({ status: 'no_rule' });
    await inferRule(llm, ctx, {
      draft: 'DRAFT_marker_aaa',
      final: 'FINAL_marker_bbb',
    });
    const req = captured()!;
    // Absent from the cacheable system + tool prefix.
    expect(req.system).not.toContain('DRAFT_marker_aaa');
    expect(req.system).not.toContain('FINAL_marker_bbb');
    expect(JSON.stringify(req.tools)).not.toContain('DRAFT_marker_aaa');
    // Present in the user message.
    const user = req.messages.map((m) => m.content).join('\n');
    expect(user).toContain('DRAFT_marker_aaa');
    expect(user).toContain('FINAL_marker_bbb');
  });
});

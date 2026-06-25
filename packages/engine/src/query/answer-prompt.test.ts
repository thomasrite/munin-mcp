import { describe, expect, it } from 'vitest';

import { ANSWER_TOOL_NAME, NO_EVIDENCE_MESSAGE, assembleAnswerPrompt } from './answer-prompt';

describe('assembleAnswerPrompt', () => {
  it('produces a forced-tool prompt with the submit_answer tool', () => {
    const p = assembleAnswerPrompt();
    expect(p.toolName).toBe(ANSWER_TOOL_NAME);
    expect(p.tool.name).toBe(ANSWER_TOOL_NAME);
    const schema = p.tool.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(['status', 'answer', 'citations']);
  });

  it('is deterministic — identical bytes on every call (stable cache prefix)', () => {
    const a = assembleAnswerPrompt();
    const b = assembleAnswerPrompt();
    expect(a.system).toBe(b.system);
    expect(JSON.stringify(a.tool)).toBe(JSON.stringify(b.tool));
  });

  it('instructs the model to refuse rather than use general knowledge', () => {
    const { system } = assembleAnswerPrompt();
    expect(system.toLowerCase()).toContain('no_evidence');
    expect(system.toLowerCase()).toContain('general knowledge');
    expect(NO_EVIDENCE_MESSAGE.length).toBeGreaterThan(0);
  });
});

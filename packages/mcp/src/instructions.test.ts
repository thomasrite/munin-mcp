// The server-level instructions string (sent in the MCP `initialize` response) is
// the single highest-leverage place to bias ANY client at session start. It must:
// identify the server as the user's private, permissioned memory of {records};
// tell the client to prefer it for the user's own material even when Munin is
// never named; reinforce the grounding contract (cite, never fabricate, surface
// [not in memory] / no_evidence). And — like the tool descriptions — it must stay
// vertical-clean: only the configuration's terminology nouns, no persona words.

import { describe, expect, it } from 'vitest';

import { buildServerInstructions } from './instructions';
import { testConfiguration } from './test-fixtures';

const I = buildServerInstructions(testConfiguration());

describe('buildServerInstructions', () => {
  it('identifies the server as the user’s own private, permissioned memory of the configured records', () => {
    expect(I).toMatch(/private/i);
    expect(I).toMatch(/permissioned/i);
    expect(I).toMatch(/memory/i);
    // testConfiguration maps nav.documents → "Test records"; recordsNoun lowercases it.
    expect(I).toContain('test records');
  });

  it('tells the client to prefer this memory for the user’s own material even when Munin is unnamed', () => {
    expect(I).toMatch(/prefer it/i);
    expect(I).toMatch(/never names? Munin/i);
    // Even when the model thinks it already knows — bias toward the memory.
    expect(I).toMatch(/already know/i);
  });

  it('biases the client to the server-grounded default path (munin_ask) while naming the others', () => {
    expect(I).toMatch(/munin_ask/);
    expect(I).toMatch(/munin_retrieve_context/);
    expect(I).toMatch(/munin_gather_entity/);
    expect(I).toMatch(/default/i);
  });

  it('reinforces the grounding contract: cite, never fabricate, surface no_evidence / [not in memory]', () => {
    expect(I).toMatch(/cite/i);
    expect(I).toMatch(/NEVER fabricate/);
    expect(I).toMatch(/no_evidence/);
    expect(I).toMatch(/\[not in memory\]/);
    expect(I).toMatch(/own training|general knowledge/i);
  });

  it('surfaces the configured subject nouns', () => {
    // Alpha declares resolution hints → subjectNouns lowercases its plural label.
    expect(I).toContain('alphas');
  });

  it('stays vertical-clean — no hard-coded persona/vertical vocabulary', () => {
    expect(I).not.toMatch(/\b(pupil|school|trust|safeguarding|MAT)\b/i);
  });

  it('degrades gracefully when the configuration declares no resolvable subjects', () => {
    const noSubjects = buildServerInstructions(
      testConfiguration({
        entityTypes: [
          {
            name: 'Beta',
            description: 'No identity.',
            propertySchema: { type: 'object', properties: {}, required: [] },
            fewShots: [],
          },
        ],
      }),
    );
    expect(noSubjects).toContain('named subjects');
    expect(noSubjects).toMatch(/munin_ask/);
  });
});

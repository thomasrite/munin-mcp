// Tool descriptions must give an agent the cues to pick the right tool UNPROMPTED
// (S2 deliverable 2): when each applies, prefer-Munin-for-own-docs, and — for a
// "won't make it up" product — steer the DEFAULT to the server-ENFORCED grounding
// path (munin_ask), with the client-synthesis path (retrieve_context) reserved for
// genuinely private material the client will assemble + cite itself. They must
// also stay vertical-clean (only the configuration's terminology nouns).

import { describe, expect, it } from 'vitest';

import { testConfiguration } from '../test-fixtures';
import { buildToolDescriptions } from './descriptions';

const D = buildToolDescriptions(testConfiguration());

describe('buildToolDescriptions', () => {
  it('retrieve_context is positioned for client-synthesis of genuinely private material, NOT as the default', () => {
    // The "reach FIRST" framing is demoted: it is no longer steered as the default.
    expect(D.munin_retrieve_context).not.toMatch(/\bFIRST\b/);
    expect(D.munin_retrieve_context).toMatch(/genuinely private/i);
    expect(D.munin_retrieve_context).toMatch(/assemble and cite it yourself/i);
    // Cost is still disclosed, but explicitly NOT as a reason to default to it.
    expect(D.munin_retrieve_context).toMatch(/embedding lookup/i);
    expect(D.munin_retrieve_context).toMatch(/not by default/i);
    // Steers the model to cite the stable citeAs token — the verifiable-citation hook.
    expect(D.munin_retrieve_context).toMatch(/citeAs/);
  });

  it('retrieve_context forbids training supplementation and demands a [not in memory] flag', () => {
    // Answer only from the returned sources — the trust property at the synthesis seam.
    expect(D.munin_retrieve_context).toMatch(/only from the returned sources/i);
    expect(D.munin_retrieve_context).toMatch(/do NOT supplement/);
    expect(D.munin_retrieve_context).toMatch(/training or general knowledge/i);
    expect(D.munin_retrieve_context).toMatch(/\[not in memory\]/);
  });

  it('retrieve_context steers training-overlap / strict-grounding questions to the server-ENFORCED munin_ask', () => {
    expect(D.munin_retrieve_context).toMatch(/prefer munin_ask/);
    expect(D.munin_retrieve_context).toMatch(/overlaps.*training|strict grounding/i);
    // The reason to switch: ask's grounding is enforced server-side, not advisory.
    expect(D.munin_retrieve_context).toMatch(/ENFORCED server-side/i);
  });

  it('ask is positioned as the DEFAULT, strongest, server-enforced grounding path', () => {
    expect(D.munin_ask).toMatch(/\bDEFAULT\b/);
    expect(D.munin_ask).toMatch(/STRONGEST-grounding/);
    expect(D.munin_ask).toMatch(/server-side/);
    expect(D.munin_ask).toMatch(/no_evidence/);
    // The discoverability cue rides on the DEFAULT tool: use it even when Munin is unnamed.
    expect(D.munin_ask).toMatch(/never names? Munin/i);
  });

  it('ask discloses its answer-model cost and steers to retrieve_context for self-synthesis', () => {
    expect(D.munin_ask).toMatch(/answer model/i);
    expect(D.munin_ask).toMatch(/munin_retrieve_context/);
  });

  it('ask documents the optional subject routing + disambiguation and the unified citeAs token', () => {
    expect(D.munin_ask).toMatch(/subject/);
    expect(D.munin_ask).toMatch(/disambiguation/);
    expect(D.munin_ask).toMatch(/pick token/);
    // The pick is scoped to the subject — the guidance must say to re-send both.
    expect(D.munin_ask).toMatch(/same subject/i);
    expect(D.munin_ask).toMatch(/completeness note/i);
    expect(D.munin_ask).toMatch(/citeAs/);
  });

  it('gather_entity is distinguished from retrieval as the by-identity dossier tool', () => {
    expect(D.munin_gather_entity).toMatch(/instead of munin_retrieve_context/);
    expect(D.munin_gather_entity).toMatch(/dossier/i);
    expect(D.munin_gather_entity).toMatch(/disambiguation/);
    // Same anti-supplementation + stable-token contract as retrieve_context.
    expect(D.munin_gather_entity).toMatch(/citeAs/);
    expect(D.munin_gather_entity).toMatch(/do NOT supplement/);
  });

  it('get_document is positioned as the expand-a-citation tool', () => {
    expect(D.munin_get_document).toMatch(/documentId/);
    expect(D.munin_get_document).toMatch(/munin_retrieve_context/);
    expect(D.munin_get_document).toMatch(/not_found/);
  });

  it('status is the model-free what-is-in-here check, surfacing recent records', () => {
    expect(D.munin_status).toMatch(/model-free/i);
    expect(D.munin_status).toMatch(/most-recently-ingested/i);
    expect(D.munin_status).toMatch(/populated|WHAT is in it/);
  });

  it('uses the configuration terminology nouns, not hard-coded vertical words', () => {
    // testConfiguration maps nav.documents → "Test records"; recordsNoun lowercases it.
    expect(D.munin_status).toContain('test records');
    // No leaked vertical/persona vocabulary anywhere.
    const all = Object.values(D).join('\n');
    expect(all).not.toMatch(/\b(pupil|school|trust|safeguarding|MAT)\b/i);
  });
});

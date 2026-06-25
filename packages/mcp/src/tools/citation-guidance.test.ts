// The citation-guidance constants must actually instruct inline citation and
// honest "unsupported" reporting — that is the whole point of S2 deliverable 1.

import { describe, expect, it } from 'vitest';

import { ASK_CITATION_GUIDANCE, SOURCES_CITATION_GUIDANCE } from './citation-guidance';

describe('SOURCES_CITATION_GUIDANCE', () => {
  it('tells the caller to cite the stable citeAs token inline per claim', () => {
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/citeAs/);
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/square brackets/i);
    // Carries a concrete inline-citation example in the citeAs shape (S + hex),
    // so the model has a stable pattern to copy rather than the per-call P-n.
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/\[S[0-9a-f]+\]/);
  });

  it('forbids supplementing from the model’s own training/general knowledge', () => {
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/only from the sources/i);
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/training or general knowledge/i);
    // Even high confidence is not a licence to add un-sourced facts.
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/confident/i);
  });

  it('requires flagging uncovered claims as [not in memory] rather than filling the gap', () => {
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/\[not in memory\]/);
    expect(SOURCES_CITATION_GUIDANCE).toMatch(/say so|do not cover/i);
  });
});

describe('ASK_CITATION_GUIDANCE', () => {
  it('tells the caller to preserve the [n] markers', () => {
    expect(ASK_CITATION_GUIDANCE).toMatch(/\[n\]/);
    expect(ASK_CITATION_GUIDANCE).toMatch(/citations\[\]/);
  });

  it('tells the caller to report no_evidence plainly', () => {
    expect(ASK_CITATION_GUIDANCE).toMatch(/no_evidence/);
    expect(ASK_CITATION_GUIDANCE).toMatch(/do not substitute your own knowledge/i);
  });

  it('names the stable citeAs token so ask citations unify with the source-returning tools', () => {
    expect(ASK_CITATION_GUIDANCE).toMatch(/citeAs/);
    expect(ASK_CITATION_GUIDANCE).toMatch(/munin_retrieve_context|munin_gather_entity/);
  });
});

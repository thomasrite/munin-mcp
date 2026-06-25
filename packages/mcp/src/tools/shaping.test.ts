// Result shaping: engine shapes → the JSON the MCP client sees.

import type { ContextSource, DisambiguationGroup } from '@muninhq/engine';
import { describe, expect, it } from 'vitest';

import { effectiveQuestion } from './retrieve-context';
import { completenessBanner, computeCiteAs, shapeDisambiguation, shapeSource } from './shaping';

function source(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    sourceId: 'P1',
    method: 'vector',
    distance: 0.12,
    documentTitle: 'Doc One',
    paragraph: {
      id: 'para-1',
      tenantId: 'tenant-1',
      documentId: 'doc-1',
      paragraphIndex: 3,
      page: 2,
      text: 'The paragraph text.',
      structure: 'prose',
      accessTags: ['x'],
      createdBy: 'actor',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      deletedAt: null,
      // reason: test fixture — the branded-ID fields are plain strings here.
    } as never,
    ...overrides,
  };
}

describe('shapeSource', () => {
  it('projects the fields a client needs to cite', () => {
    expect(shapeSource(source())).toEqual({
      sourceId: 'P1',
      citeAs: computeCiteAs('doc-1', 'para-1'),
      text: 'The paragraph text.',
      documentTitle: 'Doc One',
      documentId: 'doc-1',
      paragraphId: 'para-1',
      method: 'vector',
      distance: 0.12,
    });
  });

  it('maps a missing documentTitle and structural distance to null', () => {
    const { documentTitle: _omitted, ...withoutTitle } = source({ distance: null });
    const shaped = shapeSource(withoutTitle);
    expect(shaped.documentTitle).toBeNull();
    expect(shaped.distance).toBeNull();
  });

  it('derives citeAs from the paragraph’s document+paragraph identity, not the per-call sourceId', () => {
    const shaped = shapeSource(source({ sourceId: 'P7' }));
    // The per-call ordinal changed (P1 → P7) but citeAs is identity-derived and stable.
    expect(shaped.citeAs).toBe(computeCiteAs('doc-1', 'para-1'));
    expect(shaped.citeAs).not.toBe('P7');
  });
});

describe('computeCiteAs', () => {
  it('is STABLE: the same document+paragraph identity yields the same token', () => {
    // The whole point — two retrieval calls in one conversation that surface the
    // same paragraph must produce the same citation token so references hold.
    expect(computeCiteAs('doc-1', 'para-1')).toBe(computeCiteAs('doc-1', 'para-1'));
  });

  it('is DISTINCT across different paragraphs and different documents', () => {
    const a = computeCiteAs('doc-1', 'para-1');
    const b = computeCiteAs('doc-1', 'para-2'); // same doc, different paragraph
    const c = computeCiteAs('doc-2', 'para-1'); // different doc, same paragraph index/id
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('does not confuse the two id fields (the separator is injective over the pair)', () => {
    // Without a separator, ("ab","c") and ("a","bc") would hash identically; with
    // one they must not. Distinct identities → distinct tokens.
    expect(computeCiteAs('ab', 'c')).not.toBe(computeCiteAs('a', 'bc'));
  });

  it('emits a short, citation-friendly token in the documented S-prefixed shape', () => {
    expect(computeCiteAs('doc-1', 'para-1')).toMatch(/^S[0-9a-f]{12}$/);
  });
});

describe('shapeDisambiguation', () => {
  const group: DisambiguationGroup = {
    identityKey: 'a. example',
    resolverUncertain: false,
    candidates: [
      {
        token: 'tok-1',
        logicalKey: 'a. example',
        entityType: 'Alpha',
        memberIds: ['e1'],
        distinguishing: { group: ['North'] },
        visibleRecordCount: 1,
      },
      {
        token: 'tok-2',
        logicalKey: 'a. example',
        entityType: 'Alpha',
        memberIds: ['e2'],
        distinguishing: { group: ['South'] },
        visibleRecordCount: 2,
      },
    ],
  };

  it('exposes each candidate with its pick token and distinguishing values', () => {
    const shaped = shapeDisambiguation('A. Example', group, false, 'munin_gather_entity');
    expect(shaped.status).toBe('disambiguation');
    expect(shaped.candidates).toHaveLength(2);
    expect(shaped.candidates[0]).toEqual({
      pick: 'tok-1',
      label: 'a. example',
      entityType: 'Alpha',
      distinguishing: { group: ['North'] },
      visibleRecordCount: 1,
    });
    expect(shaped.message).toContain('pick');
    expect(shaped.message).not.toContain('stale');
  });

  it('tells the client to re-call the GIVEN tool with the same subject + pick token', () => {
    // Naming the right tool stops an ask-originated disambiguation steering the
    // client onto a weaker surface; re-sending the subject keeps the pick scoped.
    const viaAsk = shapeDisambiguation('A. Example', group, false, 'munin_ask');
    expect(viaAsk.message).toContain('munin_ask');
    expect(viaAsk.message).not.toContain('munin_gather_entity');
    expect(viaAsk.message).toContain('same subject');
    expect(viaAsk.message).toContain('A. Example');

    const viaGather = shapeDisambiguation('A. Example', group, false, 'munin_gather_entity');
    expect(viaGather.message).toContain('munin_gather_entity');
  });

  it('notes a stale pick so the client re-presents', () => {
    const shaped = shapeDisambiguation('A. Example', group, true, 'munin_gather_entity');
    expect(shaped.message).toMatch(/no longer matches/i);
  });
});

describe('completenessBanner', () => {
  it('is null when the gather is believed complete', () => {
    expect(completenessBanner('X', false)).toBeNull();
  });
  it('names the subject when records may be unlinked', () => {
    expect(completenessBanner('X', true)).toMatch(/about "X"/);
  });
});

describe('effectiveQuestion', () => {
  it('returns the question verbatim with no subject', () => {
    expect(effectiveQuestion({ question: 'What happened?' })).toBe('What happened?');
  });
  it('folds an explicit subject into the question', () => {
    expect(effectiveQuestion({ question: 'What happened?', subject: 'A. Example' })).toBe(
      'What happened? (about A. Example)',
    );
  });
  it('does not duplicate a subject already named in the question', () => {
    expect(
      effectiveQuestion({ question: 'What happened to a. example?', subject: 'A. Example' }),
    ).toBe('What happened to a. example?');
  });
});

import { describe, expect, it } from 'vitest';

import { reconcileMarkers } from './marker-reconcile';

interface C {
  readonly marker: number;
  readonly sourceId: string;
}

describe('reconcileMarkers', () => {
  it('leaves a consistent answer + citations unchanged', () => {
    const r = reconcileMarkers<C>('Apollo ships in Q3 [1], led by Jones [2].', [
      { marker: 1, sourceId: 'P1' },
      { marker: 2, sourceId: 'P2' },
    ]);
    expect(r.citations.map((c) => c.marker)).toEqual([1, 2]);
    expect(r.answer).toBe('Apollo ships in Q3 [1], led by Jones [2].');
  });

  it('drops citations whose marker never appears in the text', () => {
    const r = reconcileMarkers<C>('Apollo ships in Q3 [1].', [
      { marker: 1, sourceId: 'P1' },
      { marker: 2, sourceId: 'P2' }, // unused
    ]);
    expect(r.citations.map((c) => c.marker)).toEqual([1]);
  });

  it('strips an orphan marker (in text, no surviving citation) and tidies punctuation', () => {
    const r = reconcileMarkers<C>('Apollo ships in Q3 [2], led by Jones [1].', [
      { marker: 1, sourceId: 'P1' },
      // marker 2 has no citation
    ]);
    expect(r.citations.map((c) => c.marker)).toEqual([1]);
    expect(r.answer).toBe('Apollo ships in Q3, led by Jones [1].');
  });

  it('collapses spacing left by a removed trailing marker', () => {
    const r = reconcileMarkers<C>('It ships in Q3 [9].', []);
    expect(r.citations).toEqual([]);
    expect(r.answer).toBe('It ships in Q3.');
  });

  it('handles multi-digit markers', () => {
    const r = reconcileMarkers<C>('A [12] and B [3].', [
      { marker: 12, sourceId: 'P12' },
      { marker: 3, sourceId: 'P3' },
    ]);
    expect(r.citations.map((c) => c.marker).sort((a, b) => a - b)).toEqual([3, 12]);
    expect(r.answer).toBe('A [12] and B [3].');
  });

  it('returns empty citations when all markers are orphans', () => {
    const r = reconcileMarkers<C>('Claim one [1] and claim two [2].', []);
    expect(r.citations).toEqual([]);
    expect(r.answer).toBe('Claim one and claim two.');
  });
});

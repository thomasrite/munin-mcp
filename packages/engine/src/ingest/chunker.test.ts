import { describe, expect, it } from 'vitest';

import { chunkBlocks, estimateTokens, segmentSentences } from './chunker';
import type { ParsedBlock } from './parsers/parser-types';

describe('estimateTokens', () => {
  it('returns ceil(chars / 3.5)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('a'.repeat(36))).toBe(11);
  });
});

describe('segmentSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(segmentSentences('Hello world. This is fine. Is it?')).toEqual([
      'Hello world.',
      'This is fine.',
      'Is it?',
    ]);
  });

  it('respects common abbreviations', () => {
    const result = segmentSentences('Mr. Smith is here. He arrived at 9am.');
    expect(result.length).toBe(2);
    expect(result[0]).toBe('Mr. Smith is here.');
  });

  it('handles empty input', () => {
    expect(segmentSentences('')).toEqual([]);
    expect(segmentSentences('   ')).toEqual([]);
  });

  it('treats a trailing fragment as a sentence', () => {
    expect(segmentSentences('No terminal punctuation here')).toEqual([
      'No terminal punctuation here',
    ]);
  });
});

describe('chunkBlocks', () => {
  const block = (text: string, structure = {}): ParsedBlock => ({ text, structure });

  it('returns empty array for no blocks', () => {
    expect(chunkBlocks([])).toEqual([]);
  });

  it('packs short blocks into a single chunk', () => {
    const chunks = chunkBlocks([
      block('First sentence here.'),
      block('Second sentence is also short.'),
      block('Third one.'),
    ]);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toContain('First sentence here.');
    expect(chunks[0]?.text).toContain('Second sentence is also short.');
  });

  it('splits when target token budget would be exceeded', () => {
    // Each block is ~30 tokens; with target=50 we should split.
    const blocks = Array.from({ length: 8 }, (_, i) =>
      block(`Sentence number ${i} carries a chunk of moderate length so we exceed the budget.`),
    );
    const chunks = chunkBlocks(blocks, { targetTokens: 50, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(80);
    }
  });

  it('overlaps successive chunks by approximately overlapTokens', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence ${i} ends here.`).join(' ');
    const chunks = chunkBlocks([block(sentences)], { targetTokens: 40, overlapTokens: 15 });
    expect(chunks.length).toBeGreaterThan(2);
    // Verify overlap: the last sentence of chunk[i] should appear in chunk[i+1].
    for (let i = 0; i < chunks.length - 1; i++) {
      const lastSentence = chunks[i]!.text.match(/Sentence \d+ ends here\./g)?.slice(-1)[0];
      expect(chunks[i + 1]!.text).toContain(lastSentence!);
    }
  });

  it('respects the hard ceiling for oversize sentences', () => {
    const oversize = `a, ${'word '.repeat(2000)}.`;
    const chunks = chunkBlocks([block(oversize)], {
      targetTokens: 100,
      hardCeilingTokens: 200,
    });
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(220);
    }
  });

  it("inherits the first block's structure as the chunk's structure", () => {
    const chunks = chunkBlocks([
      block('Heading-context sentence.', { headingPath: ['One', 'Two'], page: 3 }),
    ]);
    expect(chunks[0]?.structure).toEqual({ headingPath: ['One', 'Two'], page: 3 });
  });
});

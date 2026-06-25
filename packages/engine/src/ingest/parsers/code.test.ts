import { describe, expect, it } from 'vitest';

import { CODE_FILE_EXTENSIONS, codeParser, splitIntoCodeBlocks } from './code';
import { findParserByExtension } from './parser-registry';

const enc = (s: string) => new TextEncoder().encode(s);

describe('splitIntoCodeBlocks', () => {
  it('returns no blocks for empty or whitespace-only input', () => {
    expect(splitIntoCodeBlocks('')).toEqual([]);
    expect(splitIntoCodeBlocks('   \n\n\t\n')).toEqual([]);
  });

  it('keeps a small file as a single block, preserving newlines', () => {
    const src = 'const x = 1;\nfunction f() {\n  return x;\n}';
    const blocks = splitIntoCodeBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(src);
    expect(blocks[0]?.text).toContain('\n');
  });

  it('splits on line boundaries only — never mid-line — and stays size-bounded', () => {
    const lines = ['line one', 'line two', 'line three', 'line four'];
    const blocks = splitIntoCodeBlocks(lines.join('\n'), 20);
    // Deterministic packing at maxChars=20.
    expect(blocks.map((b) => b.text)).toEqual(['line one\nline two', 'line three', 'line four']);
    // Every block (none is a single over-long line here) is within the budget.
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(20);
    // Every line of every block is an exact source line — nothing was sliced.
    const sourceLines = new Set(lines);
    for (const b of blocks) {
      for (const ln of b.text.split('\n')) expect(sourceLines.has(ln)).toBe(true);
    }
  });

  it('emits an over-long single line as its own intact block (still never split)', () => {
    const long = 'x'.repeat(50);
    const blocks = splitIntoCodeBlocks(['a', long, 'b'].join('\n'), 20);
    expect(blocks.map((b) => b.text)).toEqual(['a', long, 'b']);
    expect(blocks[1]?.text.length).toBe(50);
  });

  it('normalises CRLF / CR line endings to LF', () => {
    const blocks = splitIntoCodeBlocks('a\r\nb\rc\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('a\nb\nc');
  });

  it('reconstructs the source lines in order across blocks', () => {
    const src = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const blocks = splitIntoCodeBlocks(src, 60);
    expect(blocks.length).toBeGreaterThan(1);
    const rejoined = blocks.flatMap((b) => b.text.split('\n')).join('\n');
    expect(rejoined).toBe(src);
  });
});

describe('codeParser', () => {
  it('decodes UTF-8 source and reports extractable text', async () => {
    const parsed = await codeParser.parse(enc('def main():\n    print("hi")\n'));
    expect(parsed.textWasExtractable).toBe(true);
    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(parsed.blocks.map((b) => b.text).join('\n')).toContain('print("hi")');
  });

  it('treats an empty file as no extractable text', async () => {
    const parsed = await codeParser.parse(new Uint8Array());
    expect(parsed.blocks).toEqual([]);
    expect(parsed.textWasExtractable).toBe(false);
  });

  it('tolerates invalid UTF-8 bytes without throwing', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x0a, 0x42]); // bad bytes + "A\nB"
    const parsed = await codeParser.parse(bytes);
    expect(parsed.textWasExtractable).toBe(true);
  });

  it('exposes a broad, document-disjoint extension set', () => {
    for (const e of ['.ts', '.tsx', '.py', '.go', '.rs', '.java', '.sql', '.yaml', '.json']) {
      expect(CODE_FILE_EXTENSIONS).toContain(e);
    }
    // Prose formats (owned by other parsers) and secret-bearing values files
    // are deliberately excluded.
    for (const doc of ['.pdf', '.docx', '.md', '.markdown', '.txt', '.text', '.env', '.tfvars']) {
      expect(CODE_FILE_EXTENSIONS).not.toContain(doc);
    }
  });
});

describe('parser registry routing', () => {
  it('routes source-code extensions to the code parser', () => {
    for (const e of ['.ts', '.py', '.go', '.json', '.yaml']) {
      expect(findParserByExtension(e)).toBe(codeParser);
    }
  });

  it('does not hijack the prose extensions owned by other parsers', () => {
    for (const e of ['.md', '.markdown', '.txt', '.text']) {
      const p = findParserByExtension(e);
      expect(p).toBeDefined();
      expect(p).not.toBe(codeParser);
    }
  });
});

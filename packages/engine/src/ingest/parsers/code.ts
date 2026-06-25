// Source-code / structured-text parser.
//
// Code is already text — there is no binary container to crack open, so this
// parser just decodes the bytes as UTF-8 and groups them into size-bounded
// blocks. The grouping is LINE-AWARE: a block is a run of whole lines and a
// line is never split across blocks (a single over-long line becomes its own
// block). This keeps a function/short block together where it fits the budget,
// which is the cheap, no-engine-change version of "code-aware" chunking.
//
// Vertical-agnostic: "code" is a universal content type, exactly like plain
// text or markdown. This parser knows nothing about any domain.
//
// NOTE on the downstream chunker. The ingestion pipeline runs `chunkBlocks`
// over a parser's blocks, and that shared chunker re-segments on sentences and
// collapses internal whitespace (`\s+` -> ' '). So although THIS parser
// preserves newlines/indentation within each block, the stored paragraph text
// is currently whitespace-collapsed by the pipeline. Preserving code formatting
// end-to-end (and attaching line ranges to provenance) needs a generic,
// vertical-agnostic change to the engine chunker/`ParagraphStructure` and is
// intentionally left as a flagged follow-up.
// are sized just under the chunker's ~400-token target so each tends to map to
// a single downstream chunk.

import { CODE_FILE_EXTENSIONS, CODE_MIME_TYPES } from './code-extensions';
import {
  type DocumentParser,
  ParseError,
  type ParsedBlock,
  type ParsedDocument,
} from './parser-types';

// The canonical extension / mime sets live in the zero-dependency leaf
// `./code-extensions` so lightweight consumers (the filesystem connector) can
// import the extension list without dragging in the parser machinery or the
// heavy `@muninhq/engine` barrel. Re-exported here so existing `from './code'`
// consumers (the parser registry, the engine barrel) are unaffected.
export { CODE_FILE_EXTENSIONS };

// Keep in step with the chunker's estimate (chars / 3.5 ~= tokens). Blocks are
// sized a little under the chunker's 400-token target so re-chunking is close
// to a 1:1 pass-through.
const CHARS_PER_TOKEN = 3.5;
const DEFAULT_BLOCK_TOKENS = 350;
const DEFAULT_MAX_BLOCK_CHARS = Math.floor(DEFAULT_BLOCK_TOKENS * CHARS_PER_TOKEN);

export const codeParser: DocumentParser = {
  mimeTypes: CODE_MIME_TYPES,
  extensions: CODE_FILE_EXTENSIONS,

  async parse(bytes: Uint8Array): Promise<ParsedDocument> {
    let text: string;
    try {
      // `fatal: false` -> invalid byte sequences become U+FFFD rather than
      // throwing, so a stray non-UTF-8 byte never fails a whole file.
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (err) {
      throw new ParseError('code', 'failed to decode source as UTF-8 text', err);
    }
    const blocks = splitIntoCodeBlocks(text);
    return { blocks, textWasExtractable: blocks.length > 0 };
  },
};

// Line-aware, size-bounded block splitter.
//
// Guarantees:
//   * a line is NEVER split across blocks (a single line longer than the budget
//     becomes its own block, intact);
//   * each block is a contiguous run of whole lines from the source, in order;
//   * newlines/indentation are preserved WITHIN a block (joined with '\n');
//   * whitespace-only runs do not produce empty blocks.
export function splitIntoCodeBlocks(
  source: string,
  maxChars: number = DEFAULT_MAX_BLOCK_CHARS,
): ParsedBlock[] {
  const normalised = source.replace(/\r\n?/g, '\n');
  if (normalised.trim().length === 0) return [];

  const lines = normalised.split('\n');
  const blocks: ParsedBlock[] = [];
  let current: string[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    // Trim trailing blank lines/spaces but keep the internal line structure.
    const text = current.join('\n').replace(/\s+$/, '');
    if (text.trim().length > 0) blocks.push({ text, structure: {} });
    current = [];
    currentChars = 0;
  };

  for (const line of lines) {
    // An over-long single line stands alone — still never split mid-line.
    if (line.length >= maxChars) {
      flush();
      const text = line.replace(/\s+$/, '');
      if (text.trim().length > 0) blocks.push({ text, structure: {} });
      continue;
    }
    const lineCost = line.length + 1; // +1 for the joining newline
    if (current.length > 0 && currentChars + lineCost > maxChars) {
      flush();
    }
    current.push(line);
    currentChars += lineCost;
  }
  flush();

  return blocks;
}

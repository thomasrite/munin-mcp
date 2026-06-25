// Markdown parser. Splits on blank lines (block-level), tracks heading
// path from `#`/`##`/`###` markers, attaches the active heading path to
// every subsequent block.

import {
  type DocumentParser,
  ParseError,
  type ParsedBlock,
  type ParsedDocument,
} from './parser-types';

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export const markdownParser: DocumentParser = {
  mimeTypes: ['text/markdown'],
  extensions: ['.md', '.markdown'],

  async parse(bytes: Uint8Array): Promise<ParsedDocument> {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const text = decoder.decode(bytes);
      const rawBlocks = text
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);

      const headingStack: string[] = [];
      const blocks: ParsedBlock[] = [];
      let ordinal = 0;

      for (const raw of rawBlocks) {
        const match = HEADING.exec(raw.split('\n')[0] ?? '');
        if (match) {
          const hashes = match[1];
          const headingText = match[2];
          if (hashes === undefined || headingText === undefined) continue;
          const level = hashes.length;
          const title = headingText.trim();
          // Truncate the stack to the current level - 1, then push this title.
          headingStack.length = Math.max(0, level - 1);
          headingStack[level - 1] = title;
          ordinal = 0;
          // The heading line itself is not treated as a content block —
          // citations point at the paragraph under the heading, not the
          // heading itself.
          continue;
        }
        const headingPath = headingStack.filter((h): h is string => typeof h === 'string');
        blocks.push({
          text: raw,
          structure: {
            ...(headingPath.length > 0 ? { headingPath } : {}),
            ordinalWithinSection: ordinal++,
          },
        });
      }

      return { blocks, textWasExtractable: blocks.length > 0 };
    } catch (err) {
      throw new ParseError('markdown', 'failed to parse markdown', err);
    }
  },
};

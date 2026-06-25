// DOCX parser via `mammoth`. Mammoth converts DOCX to HTML; we parse the
// HTML for headings and paragraphs. Simple regex parse — DOCX HTML output
// is well-structured, no need for a full DOM library.

import mammoth from 'mammoth';

import {
  type DocumentParser,
  ParseError,
  type ParsedBlock,
  type ParsedDocument,
} from './parser-types';

// Match either heading or paragraph, in document order.
const BLOCK_TAG = /<(h[1-6]|p)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;

export const docxParser: DocumentParser = {
  mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  extensions: ['.docx'],

  async parse(bytes: Uint8Array): Promise<ParsedDocument> {
    try {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      const html = result.value;

      const blocks: ParsedBlock[] = [];
      const headingStack: string[] = [];
      let ordinal = 0;

      // Reset stateful regex.
      BLOCK_TAG.lastIndex = 0;
      let match = BLOCK_TAG.exec(html);
      while (match !== null) {
        const tagMatch = match[1];
        const innerMatch = match[2];
        match = BLOCK_TAG.exec(html);
        if (tagMatch === undefined || innerMatch === undefined) continue;
        const tag = tagMatch.toLowerCase();
        const inner = stripTags(innerMatch).trim();
        if (inner.length === 0) continue;
        if (tag.startsWith('h')) {
          const level = Number.parseInt(tag.slice(1), 10);
          headingStack.length = Math.max(0, level - 1);
          headingStack[level - 1] = inner;
          ordinal = 0;
          continue;
        }
        // paragraph
        const headingPath = headingStack.filter((h): h is string => typeof h === 'string');
        blocks.push({
          text: inner,
          structure: {
            ...(headingPath.length > 0 ? { headingPath } : {}),
            ordinalWithinSection: ordinal++,
          },
        });
      }

      return { blocks, textWasExtractable: blocks.length > 0 };
    } catch (err) {
      throw new ParseError('docx', 'failed to parse DOCX', err);
    }
  },
};

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

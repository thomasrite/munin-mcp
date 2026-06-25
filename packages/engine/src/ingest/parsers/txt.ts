// Plain-text parser. Splits on blank lines so each "paragraph" block is a
// genuine paragraph, not the whole file. No structural metadata.

import { type DocumentParser, ParseError, type ParsedDocument } from './parser-types';

export const txtParser: DocumentParser = {
  mimeTypes: ['text/plain'],
  extensions: ['.txt', '.text'],

  async parse(bytes: Uint8Array): Promise<ParsedDocument> {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const text = decoder.decode(bytes);
      const blocks = text
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter((b) => b.length > 0)
        .map((text) => ({ text, structure: {} }));
      const textWasExtractable = blocks.length > 0;
      return { blocks, textWasExtractable };
    } catch (err) {
      throw new ParseError('txt', 'failed to decode text', err);
    }
  },
};

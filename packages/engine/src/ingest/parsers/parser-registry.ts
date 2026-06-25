// Parser registry — maps mime type and file extension to a DocumentParser.

import { codeParser } from './code';
import { docxParser } from './docx';
import { markdownParser } from './markdown';
import { type DocumentParser, UnsupportedFormatError } from './parser-types';
import { pdfParser } from './pdf';
import { txtParser } from './txt';

// Order matters only for overlap resolution (first match wins). The code
// parser's extensions/mimes are disjoint from the prose parsers, so it sits
// last as the catch-all for source-code / structured-text formats.
const PARSERS: readonly DocumentParser[] = [
  pdfParser,
  docxParser,
  markdownParser,
  txtParser,
  codeParser,
];

export function findParserByMime(mimeType: string): DocumentParser | undefined {
  const normalised = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return PARSERS.find((p) => p.mimeTypes.includes(normalised));
}

export function findParserByExtension(extension: string): DocumentParser | undefined {
  const normalised = extension.toLowerCase();
  return PARSERS.find((p) => p.extensions.includes(normalised));
}

export function findParser(opts: { mimeType?: string; extension?: string }): DocumentParser {
  if (opts.mimeType) {
    const p = findParserByMime(opts.mimeType);
    if (p) return p;
  }
  if (opts.extension) {
    const p = findParserByExtension(opts.extension);
    if (p) return p;
  }
  throw new UnsupportedFormatError(opts.mimeType ?? opts.extension ?? '<unknown>');
}

export const ALL_PARSERS: readonly DocumentParser[] = PARSERS;

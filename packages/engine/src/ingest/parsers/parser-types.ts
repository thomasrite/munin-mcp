// Parser contract — a parser maps raw bytes to a structured-text
// representation the chunker can consume.

import type { ParagraphStructure } from '../../graph/types';

// A parsed document is a flat sequence of "blocks" — usually paragraphs.
// Each block carries an optional structural context (heading path, page).
// The chunker merges adjacent blocks into chunks until the size budget is
// hit, preserving the structural metadata.
export interface ParsedBlock {
  readonly text: string;
  readonly structure: ParagraphStructure;
}

export interface ParsedDocument {
  readonly blocks: readonly ParsedBlock[];
  // True when the source had structural content (PDF pages, DOCX
  // headings, markdown headings) but produced effectively no text. Used
  // for the "scanned PDF" warning.
  readonly textWasExtractable: boolean;
}

export interface DocumentParser {
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
  // MUST NOT mutate or detach the input `bytes`. The caller reuses the same
  // buffer after parsing (e.g. uploading the original document to blob storage),
  // so a parser that hands the buffer to a library which transfers/detaches it
  // (pdf.js does) must parse a COPY. See pdf.ts.
  parse(bytes: Uint8Array): Promise<ParsedDocument>;
}

export class UnsupportedFormatError extends Error {
  constructor(public readonly mimeOrExt: string) {
    super(`no parser registered for ${mimeOrExt}`);
    this.name = 'UnsupportedFormatError';
  }
}

export class ParseError extends Error {
  constructor(
    public readonly format: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`[${format}] ${message}`);
    this.name = 'ParseError';
  }
}

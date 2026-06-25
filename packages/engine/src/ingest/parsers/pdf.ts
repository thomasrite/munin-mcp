// PDF parser using `unpdf` (modern, serverless-friendly, no canvas dep).
//
// Extracts text per page. Heading detection from PDFs is fragile (requires font
// analysis); we don't attempt it. Citations get page-level structure.
//
// BUFFER OWNERSHIP — pdf.js (under unpdf) TRANSFERS/detaches the typed array it
// is handed, leaving the caller's `Uint8Array` backed by a *detached*
// ArrayBuffer. The ingestion pipeline reuses the input bytes after parsing (to
// upload the original document to blob storage), so we parse a COPY and never
// the caller's buffer. `DocumentParser.parse` is contractually non-mutating
// (see parser-types.ts). Skipping the copy was the cause of every PDF upload
// failing at the blob step with "Cannot perform Construct on a detached
// ArrayBuffer" — the document parsed fine, then the reused (detached) buffer
// blew up the blob `uploadData`.
//
// "Scanned PDF" detection: if the document yields fewer than 10 non-whitespace
// characters across all pages, we mark `textWasExtractable: false` so the
// pipeline reports "no text" (OCR not supported) rather than a hard failure.

import { extractText, getDocumentProxy } from 'unpdf';

import {
  type DocumentParser,
  ParseError,
  type ParsedBlock,
  type ParsedDocument,
} from './parser-types';

const SCANNED_THRESHOLD_CHARS = 10;

export const pdfParser: DocumentParser = {
  mimeTypes: ['application/pdf'],
  extensions: ['.pdf'],

  async parse(bytes: Uint8Array): Promise<ParsedDocument> {
    let pages: string[];
    try {
      // Parse a COPY — pdf.js detaches the buffer it's handed (see header note).
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const result = await extractText(pdf, { mergePages: false });
      // unpdf returns `text` as string[] (one per page) when mergePages: false.
      pages = Array.isArray(result.text) ? result.text : [result.text];
    } catch (err) {
      throw classifyPdfError(err);
    }

    const blocks: ParsedBlock[] = [];
    let totalChars = 0;

    for (let i = 0; i < pages.length; i++) {
      const pageText = (pages[i] ?? '').trim();
      if (pageText.length === 0) continue;
      totalChars += pageText.length;

      const pageBlocks = pageText
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);

      let ordinal = 0;
      for (const text of pageBlocks) {
        blocks.push({
          text,
          structure: {
            page: i + 1,
            ordinalWithinSection: ordinal++,
          },
        });
      }
    }

    const textWasExtractable = totalChars >= SCANNED_THRESHOLD_CHARS;
    return { blocks, textWasExtractable };
  },
};

// Map a pdf.js parse failure onto an operator-actionable reason. pdf.js throws
// PasswordException for encrypted PDFs and InvalidPDFException for corrupt /
// non-PDF bytes (e.g. a DOCX misnamed `.pdf`) — surface those specifically
// instead of a generic "failed".
function classifyPdfError(err: unknown): ParseError {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'PasswordException' || /password/i.test(msg)) {
    return new ParseError('pdf', 'password-protected (encrypted) PDFs are not supported', err);
  }
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(msg)) {
    return new ParseError('pdf', 'not a readable PDF — the file may be corrupt or misnamed', err);
  }
  return new ParseError('pdf', `could not parse PDF: ${msg}`, err);
}

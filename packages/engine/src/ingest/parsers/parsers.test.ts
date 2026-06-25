import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { docxParser } from './docx';
import { markdownParser } from './markdown';
import { findParser, findParserByExtension, findParserByMime } from './parser-registry';
import { ParseError, UnsupportedFormatError } from './parser-types';
import { pdfParser } from './pdf';
import { txtParser } from './txt';

const enc = (s: string) => new TextEncoder().encode(s);

// Real (committed) binary fixtures — closes F11 (PDF/DOCX parsers had no
// real-binary coverage). See __fixtures__/README.md for how they're generated.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(path.join(here, '__fixtures__', name)));
const allText = (blocks: readonly { text: string }[]): string =>
  blocks
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ');

describe('parser registry', () => {
  it('finds by extension', () => {
    expect(findParserByExtension('.txt')?.extensions).toContain('.txt');
    expect(findParserByExtension('.md')?.extensions).toContain('.md');
    expect(findParserByExtension('.markdown')?.extensions).toContain('.markdown');
    expect(findParserByExtension('.pdf')?.extensions).toContain('.pdf');
    expect(findParserByExtension('.docx')?.extensions).toContain('.docx');
  });

  it('finds by mime', () => {
    expect(findParserByMime('text/plain')?.mimeTypes).toContain('text/plain');
    expect(findParserByMime('text/markdown')?.mimeTypes).toContain('text/markdown');
    expect(findParserByMime('application/pdf')?.mimeTypes).toContain('application/pdf');
  });

  it('throws UnsupportedFormatError when no match', () => {
    expect(() => findParser({ extension: '.heic' })).toThrow(UnsupportedFormatError);
    expect(() => findParser({ mimeType: 'image/jpeg' })).toThrow(UnsupportedFormatError);
  });
});

describe('txt parser', () => {
  it('splits on blank lines', async () => {
    const result = await txtParser.parse(enc('First.\n\nSecond.\n\n\n\nThird.'));
    expect(result.blocks.map((b) => b.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('marks empty input as no-text', async () => {
    const result = await txtParser.parse(enc(''));
    expect(result.textWasExtractable).toBe(false);
  });

  it('produces empty structure', async () => {
    const result = await txtParser.parse(enc('hello'));
    expect(result.blocks[0]?.structure).toEqual({});
  });
});

describe('markdown parser', () => {
  it('extracts heading path from h1/h2/h3', async () => {
    const source =
      '# Chapter 1\n\nIntro.\n\n## Section 1.1\n\nMore text.\n\n### 1.1.1 Detail\n\nDetail text.\n\n## Section 1.2\n\nAfter.';
    const result = await markdownParser.parse(enc(source));
    expect(result.blocks).toEqual([
      {
        text: 'Intro.',
        structure: { headingPath: ['Chapter 1'], ordinalWithinSection: 0 },
      },
      {
        text: 'More text.',
        structure: { headingPath: ['Chapter 1', 'Section 1.1'], ordinalWithinSection: 0 },
      },
      {
        text: 'Detail text.',
        structure: {
          headingPath: ['Chapter 1', 'Section 1.1', '1.1.1 Detail'],
          ordinalWithinSection: 0,
        },
      },
      {
        text: 'After.',
        structure: { headingPath: ['Chapter 1', 'Section 1.2'], ordinalWithinSection: 0 },
      },
    ]);
  });

  it('handles markdown without headings', async () => {
    const result = await markdownParser.parse(enc('Just a paragraph.\n\nAnother one.'));
    expect(result.blocks.map((b) => b.text)).toEqual(['Just a paragraph.', 'Another one.']);
    expect(result.blocks[0]?.structure.headingPath).toBeUndefined();
  });
});

// F11 — real PDF/DOCX binary coverage. The fixtures are tiny real files.
describe('pdf parser (real binary)', () => {
  it('extracts page-structured text from a multi-page PDF', async () => {
    const result = await pdfParser.parse(fixture('text.pdf'));
    expect(result.textWasExtractable).toBe(true);
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
    // Page-level structure is the PDF citation unit.
    expect(result.blocks.every((b) => typeof b.structure.page === 'number')).toBe(true);
    expect(new Set(result.blocks.map((b) => b.structure.page))).toEqual(new Set([1, 2]));
    const text = allText(result.blocks);
    expect(text).toContain('Munin Research Overview');
    expect(text).toContain('Entities and relationships');
  });

  // Regression for the upload bug: pdf.js detaches the buffer it parses. The
  // ingestion pipeline reuses the SAME bytes to upload the original to blob
  // storage; if parse detaches them, the upload throws "Cannot perform Construct
  // on a detached ArrayBuffer". The parser must parse a copy and leave the
  // caller's buffer intact + reusable.
  it('does NOT detach the caller buffer (blob upload reuses it after parse)', async () => {
    const bytes = fixture('text.pdf');
    const lengthBefore = bytes.byteLength;
    await pdfParser.parse(bytes);
    expect(bytes.byteLength).toBe(lengthBefore); // detached buffers report 0
    // The exact operation the Azure SDK does on the reused bytes — must not throw.
    expect(() => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).not.toThrow();
  });

  it('flags a no-text (scanned/image-only) PDF as not extractable', async () => {
    const result = await pdfParser.parse(fixture('scanned.pdf'));
    expect(result.textWasExtractable).toBe(false);
  });

  it('throws a CLEAR ParseError for non-PDF bytes (corrupt / misnamed)', async () => {
    // A DOCX (zip) fed to the PDF parser — the `.docx.pdf` mislabel case.
    await expect(pdfParser.parse(fixture('sample.docx'))).rejects.toThrow(ParseError);
    await expect(pdfParser.parse(fixture('sample.docx'))).rejects.toThrow(
      /not a readable PDF|could not parse PDF/,
    );
  });
});

describe('docx parser (real binary)', () => {
  it('extracts paragraphs (and heading path) from a real DOCX', async () => {
    const result = await docxParser.parse(fixture('sample.docx'));
    expect(result.textWasExtractable).toBe(true);
    const text = allText(result.blocks);
    expect(text).toContain('Munin ingests documents');
    expect(text).toContain('Entities and relationships');
    // The Heading1 paragraph becomes the heading path for the body paragraphs.
    expect(result.blocks.some((b) => b.structure.headingPath?.includes('Research Overview'))).toBe(
      true,
    );
  });
});

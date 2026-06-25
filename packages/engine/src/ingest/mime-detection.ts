// Lightweight mime detection.
//
// Strategy: trust the file extension first (fast, no I/O), fall back to
// magic-byte sniffing for the small set we care about. Sources where we
// can be confident about the extension (CLI ingesting from a real
// filesystem) the extension is authoritative. Sources where the
// connector supplies metadata (M365 sends a mime type) take the mime.

import path from 'node:path';

export interface MimeDetection {
  readonly mimeType: string | undefined;
  readonly extension: string | undefined;
}

export function detectFromFilename(filename: string): MimeDetection {
  const ext = path.extname(filename).toLowerCase();
  return {
    mimeType: mimeForExtension(ext),
    extension: ext === '' ? undefined : ext,
  };
}

export function detectFromBytes(bytes: Uint8Array): MimeDetection {
  // PDF: "%PDF-"
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return { mimeType: 'application/pdf', extension: '.pdf' };
  }
  // DOCX/ZIP container: "PK\x03\x04"
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    // Could also be xlsx, pptx, zip etc. The parser dispatch will treat it
    // as docx by default; if the parser fails we report the file as
    // unparseable.
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: '.docx',
    };
  }
  // Heuristic: if it's mostly UTF-8 printable, treat as text.
  let printable = 0;
  const sample = bytes.length > 4096 ? bytes.slice(0, 4096) : bytes;
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f)) printable++;
  }
  if (sample.length > 0 && printable / sample.length > 0.9) {
    return { mimeType: 'text/plain', extension: '.txt' };
  }
  return { mimeType: undefined, extension: undefined };
}

function mimeForExtension(ext: string): string | undefined {
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.txt':
    case '.text':
      return 'text/plain';
    default:
      return undefined;
  }
}

// Central text sanitisation for parsed document text.
//
// Postgres TEXT columns cannot store the NUL byte (U+0000) — an attempt to
// insert one throws and would fail the whole document. Real user documents
// (and some source files) carry stray NULs and other C0 control characters
// that survive parsing. Strip them once, centrally, so EVERY parser path is
// covered before text reaches the chunker and the GraphStore insert.
//
// A NUL (or stray control byte) in document text carries no information, so
// this is sanitisation, not meaningful data loss. Common whitespace — tab
// (U+0009), newline (U+000A), carriage return (U+000D) — is preserved; only the
// disallowed control characters are removed.

// Disallowed control characters: the C0 block (U+0000–U+001F) and DEL (U+007F),
// minus the three whitespace controls we keep (tab \t, newline \n, carriage
// return \r). NUL (U+0000) is the one Postgres actually rejects; the rest are
// removed for the same reason (non-printing, no information) and to keep stored
// text clean. Built from char codes so no raw control byte lives in source.
const DISALLOWED_CONTROL_CHARS = buildControlCharRegex();

function buildControlCharRegex(): RegExp {
  const KEEP = new Set([0x09, 0x0a, 0x0d]); // tab, newline, carriage return
  let body = '';
  for (let code = 0x00; code <= 0x1f; code++) {
    if (!KEEP.has(code)) body += escapeCode(code);
  }
  body += escapeCode(0x7f); // DEL
  return new RegExp(`[${body}]`, 'g');
}

function escapeCode(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

// Remove disallowed control characters (NUL + other C0/DEL) from text,
// preserving tab/newline/carriage-return. Idempotent.
export function sanitiseText(text: string): string {
  return text.replace(DISALLOWED_CONTROL_CHARS, '');
}

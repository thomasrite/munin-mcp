// Sentence-greedy chunker with overlap.
//
// Inputs:  a sequence of ParsedBlocks (each with its structural metadata).
// Outputs: chunks targeting ~400 tokens, with ~50-token overlap, capped at
//          800 tokens hard.
//
// Algorithm:
//   1. Segment each block into sentences.
//   2. Walk sentences across blocks; for each sentence, decide whether
//      adding it to the current chunk would exceed the target.
//   3. When it would, emit the current chunk, then seed the next chunk
//      with the trailing sentences of the previous chunk worth ~50 tokens
//      of overlap.
//   4. Structural metadata (heading path / page) comes from the first
//      block of the chunk. Cross-section chunks attribute to the section
//      that started them.
//   5. Single sentences longer than the hard ceiling are split at clause
//      boundaries, then word boundaries.
//
// Token counting is approximate (chars / 3.5). For the chunker's purpose
// — bounding chunk size — this is plenty accurate. Real tokenisation
// happens at the embedding/LLM provider boundary.

import type { ParagraphStructure } from '../graph/types';
import type { ParsedBlock } from './parsers/parser-types';
import { sanitiseText } from './text-sanitise';

export interface ChunkOptions {
  readonly targetTokens?: number;
  readonly overlapTokens?: number;
  readonly hardCeilingTokens?: number;
}

const DEFAULT_TARGET = 400;
const DEFAULT_OVERLAP = 50;
const DEFAULT_CEILING = 800;

export interface ChunkResult {
  readonly text: string;
  readonly structure: ParagraphStructure;
}

export function chunkBlocks(
  blocks: readonly ParsedBlock[],
  opts: ChunkOptions = {},
): readonly ChunkResult[] {
  const target = opts.targetTokens ?? DEFAULT_TARGET;
  const overlap = Math.min(opts.overlapTokens ?? DEFAULT_OVERLAP, target / 2);
  const ceiling = opts.hardCeilingTokens ?? DEFAULT_CEILING;

  // Flatten all sentences with their originating block's structure.
  interface SentenceUnit {
    readonly text: string;
    readonly tokens: number;
    readonly structure: ParagraphStructure;
  }
  const sentences: SentenceUnit[] = [];
  for (const block of blocks) {
    // Central NUL/control-byte strip: every parser path funnels through here,
    // and the chunk text emitted below is the only text written to paragraph
    // rows — so a single sanitise here is sufficient. Postgres TEXT cannot hold
    // a NUL byte; sanitising keeps one stray byte from failing the document.
    const sentencesInBlock = segmentSentences(sanitiseText(block.text));
    for (const s of sentencesInBlock) {
      if (estimateTokens(s) > ceiling) {
        // Hard-split this overly-long sentence.
        for (const piece of splitOversize(s, ceiling)) {
          sentences.push({
            text: piece,
            tokens: estimateTokens(piece),
            structure: block.structure,
          });
        }
      } else {
        sentences.push({ text: s, tokens: estimateTokens(s), structure: block.structure });
      }
    }
  }

  const out: ChunkResult[] = [];
  let buffer: SentenceUnit[] = [];
  let bufferTokens = 0;

  const emit = (): void => {
    const firstUnit = buffer[0];
    if (firstUnit === undefined) return;
    out.push({
      text: buffer.map((s) => s.text).join(' '),
      structure: firstUnit.structure,
    });
  };

  for (const s of sentences) {
    if (bufferTokens > 0 && bufferTokens + s.tokens > target) {
      emit();
      // Seed the next buffer with the tail of the previous one for
      // overlap.
      const tail: SentenceUnit[] = [];
      let tailTokens = 0;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const next = buffer[i];
        if (next === undefined) break;
        if (tailTokens + next.tokens > overlap) break;
        tail.unshift(next);
        tailTokens += next.tokens;
      }
      buffer = tail;
      bufferTokens = tailTokens;
    }
    buffer.push(s);
    bufferTokens += s.tokens;
  }
  emit();

  return out;
}

// ---------------------------------------------------------------------------
// Sentence segmentation
// ---------------------------------------------------------------------------
//
// Regex-based for v1. Splits on ., !, ? followed by whitespace and an
// uppercase letter, attempting to avoid the most common abbreviation
// false-positives. See decisions.md — to be upgraded to a real segmenter
// in 1.7b if citation boundaries on real customer documents look poor.

const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Rev|Hon|vs|etc|i\.e|e\.g|c\.f|fig|no|vol|pp)\.$/i;

export function segmentSentences(text: string): readonly string[] {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised.length === 0) return [];

  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < normalised.length - 1; i++) {
    const ch = normalised[i];
    const next = normalised[i + 1];
    const after = normalised[i + 2];
    if ((ch === '.' || ch === '!' || ch === '?') && next === ' ' && after && /[A-Z(]/.test(after)) {
      const sentence = normalised.slice(start, i + 1);
      if (ABBREV.test(sentence)) continue;
      // Don't split inside a run of name initials like "J. R. Hartley". A "."
      // after a lone capital letter is only treated as an initial when it is
      // part of an initial *run* — i.e. immediately followed by another "X."
      // initial, or immediately preceded by one. This deliberately does NOT
      // suppress an ordinary sentence that happens to end in a lone capital
      // ("She earned a grade A. Then she left." / "Pupils sat in row B. The
      // lesson began."), which must still split.
      if (ch === '.' && isInitialRunDot(normalised, i)) continue;
      out.push(sentence);
      start = i + 2;
    }
  }
  const tail = normalised.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// True when the "." at index i is part of a run of name initials: the token
// ending here is a lone capital letter AND either the next token is also a
// lone-capital initial ("X.") or the previous token was. This catches the
// interior and boundary dots of "J. R. Hartley" without suppressing a real
// sentence end after a standalone lone capital ("...grade A. Then...").
function isInitialRunDot(s: string, i: number): boolean {
  // Token ending at i must be a lone capital: s[i-1] is A–Z and s[i-2] is a
  // space or the start of the string.
  const prev = s[i - 1];
  if (!prev || !/[A-Z]/.test(prev)) return false;
  const beforePrev = i >= 2 ? s[i - 2] : ' ';
  if (beforePrev !== ' ' && i !== 1) return false;

  // Followed by another initial: s[i+1] is space, s[i+2] is A–Z, s[i+3] is ".".
  const charAfter = s[i + 2];
  const followedByInitial =
    s[i + 1] === ' ' && charAfter !== undefined && /[A-Z]/.test(charAfter) && s[i + 3] === '.';

  // Preceded by another initial: "...X. " immediately before the lone capital,
  // i.e. s[i-3] === '.', s[i-4] is A–Z, s[i-5] is a space or the start.
  const charBefore = s[i - 4];
  const precededByInitial =
    s[i - 3] === '.' &&
    charBefore !== undefined &&
    /[A-Z]/.test(charBefore) &&
    (i - 5 < 0 || s[i - 5] === ' ');

  return followedByInitial || precededByInitial;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ---------------------------------------------------------------------------
// Oversize-sentence splitter
// ---------------------------------------------------------------------------

function splitOversize(sentence: string, ceiling: number): readonly string[] {
  const out: string[] = [];
  let current = '';
  // Split at clause-level first (commas, semicolons, em-dashes), then
  // fall back to word boundaries if still oversize.
  const clauses = sentence.split(/(?<=[,;—–])\s+/);
  for (const clause of clauses) {
    if (estimateTokens(clause) > ceiling) {
      // word-boundary split
      const words = clause.split(/\s+/);
      let buf = '';
      for (const w of words) {
        if (estimateTokens(buf) + estimateTokens(w) > ceiling && buf.length > 0) {
          out.push(buf.trim());
          buf = '';
        }
        buf += (buf.length === 0 ? '' : ' ') + w;
      }
      if (buf.length > 0) {
        if (current.length > 0) {
          out.push(current.trim());
          current = '';
        }
        out.push(buf.trim());
      }
      continue;
    }
    if (estimateTokens(current) + estimateTokens(clause) > ceiling && current.length > 0) {
      out.push(current.trim());
      current = '';
    }
    current += (current.length === 0 ? '' : ' ') + clause;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

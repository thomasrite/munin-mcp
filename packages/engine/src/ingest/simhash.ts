// 64-bit SimHash for near-duplicate document detection (P3a).
//
// Hand-rolled with Node built-ins only — no dependency. The pipeline:
//   tokenise → word k-grams (shingles) → stable 64-bit FNV-1a hash per shingle
//   → weighted per-bit accumulation → sign → 64-bit fingerprint, rendered as a
//   16-char lowercase hex string.
//
// Two near-identical documents produce fingerprints a small Hamming distance
// apart; unrelated documents are far apart. A near-duplicate is one whose
// fingerprint is within NEAR_DUP_HAMMING_THRESHOLD bits — it is still fully
// ingested and merely LINKED (document_duplicates), never skipped or merged.
//
// Candidate comparison is O(corpus) per ingest (a bounded scan): LSH banding to
// sub-linear is deferred until corpus volume justifies it.

const BITS = 64;
// Word k-gram size. 3 is a standard near-dup shingle width: large enough that
// unrelated text rarely shares shingles, small enough to survive light edits.
const SHINGLE_SIZE = 3;

// A document is a NEAR duplicate of another when their 64-bit fingerprints
// differ in at most this many bits. 3/64 is the conventional tight threshold —
// it catches re-exports and lightly-edited copies without linking merely
// topically-similar documents (that is the semantic path's job, not this one).
export const NEAR_DUP_HAMMING_THRESHOLD = 3;

// FNV-1a 64-bit. Deterministic, fast, dependency-free — exactly what a stable
// per-shingle hash needs (it is NOT a cryptographic hash, and does not need to
// be: collisions only add minor noise to the bit accumulation).
// (BigInt(...) form, not `…n` literals, so this file type-checks under the web
// package's ES2017 target too — the BigInt global comes from its esnext lib.)
const FNV_OFFSET = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK64 = BigInt('0xffffffffffffffff');
const ZERO = BigInt(0);
const ONE = BigInt(1);

function fnv1a64(s: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

// Lowercase, split on any non-alphanumeric run. Locale-agnostic and stable.
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function shingles(tokens: readonly string[]): string[] {
  if (tokens.length === 0) return [];
  // Too few tokens for a full k-gram → use the whole token list as one shingle
  // so very short documents still get a deterministic, content-derived value.
  if (tokens.length < SHINGLE_SIZE) return [tokens.join(' ')];
  const out: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
    out.push(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return out;
}

// Compute the 64-bit SimHash of `text` as a 16-char lowercase hex string.
// Deterministic: identical input always yields identical output. Empty / token-
// free text yields the all-zero fingerprint.
export function computeSimhash(text: string): string {
  const grams = shingles(tokenize(text));
  const acc = new Array<number>(BITS).fill(0);
  for (const gram of grams) {
    const h = fnv1a64(gram);
    for (let bit = 0; bit < BITS; bit++) {
      const isSet = (h >> BigInt(bit)) & ONE;
      acc[bit] = (acc[bit] ?? 0) + (isSet === ONE ? 1 : -1);
    }
  }
  let fp = ZERO;
  for (let bit = 0; bit < BITS; bit++) {
    if ((acc[bit] ?? 0) > 0) fp |= ONE << BigInt(bit);
  }
  return fp.toString(16).padStart(16, '0');
}

// Hamming distance between two hex fingerprints (count of differing bits).
export function hammingDistance(a: string, b: string): number {
  let x = (BigInt(`0x${a}`) ^ BigInt(`0x${b}`)) & MASK64;
  let count = 0;
  while (x > ZERO) {
    count += Number(x & ONE);
    x >>= ONE;
  }
  return count;
}

// Similarity in [0,1]: 1 = identical fingerprints, 0 = every bit differs. Used
// as the recorded `score` on a near-duplicate link.
export function simhashSimilarity(a: string, b: string): number {
  return 1 - hammingDistance(a, b) / BITS;
}

// True iff `a` and `b` are within `threshold` bits — i.e. near duplicates.
export function areNearDuplicates(
  a: string,
  b: string,
  threshold: number = NEAR_DUP_HAMMING_THRESHOLD,
): boolean {
  return hammingDistance(a, b) <= threshold;
}

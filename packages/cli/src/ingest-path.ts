// Pre-flight path validation for `munin ingest` (and the direct ingest CLI).
//
// The only thing the ingest CLI used to do with a user-supplied path was
// `path.resolve` — no existence check and no trim — so a missing or space-padded
// directory ("UNI Study Guides " with a trailing space, " munin-test" with a
// leading one) surfaced only deep in the filesystem connector as a raw
// "cannot read directory" ENOENT. This module validates and normalises the path
// at the CLI boundary and, on failure, produces a product-framed error that
// NAMES the resolved path(s) tried and suggests quoting / dragging the folder
// in. CLI-tier — no engine change.

import fs from 'node:fs';
import path from 'node:path';

// Thrown when the ingest target cannot be resolved to a readable directory. Its
// `message` is the full, friendly, multi-line guidance — callers print it as-is
// (no "ingest failed:" prefix).
export class IngestDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestDirectoryError';
  }
}

// Shared footer: how to get a tricky path right. Quoting fixes the space-padded
// cases; dragging from Finder pastes the exact path with no shell parsing at all.
const PATH_TIPS = [
  'Tips:',
  '  • If the folder name contains spaces, wrap the whole path in quotes, e.g.',
  '      munin ingest "/Users/you/UNI Study Guides"',
  '  • Or drag the folder from Finder into the terminal to paste its exact path.',
].join('\n');

type Kind = 'dir' | 'file' | 'missing';

function statKind(p: string): Kind {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 'missing';
  return st.isDirectory() ? 'dir' : 'file';
}

/**
 * Resolve a user-supplied ingest directory to an absolute path that exists and
 * is a directory. Prefers the LITERAL path (so a directory whose name
 * legitimately has leading/trailing spaces still resolves); falls back to a
 * TRIMMED variant ONLY if the literal does not resolve. Throws
 * IngestDirectoryError naming every path tried when none is a readable directory.
 */
export function resolveIngestDirectory(raw: string): string {
  const literal = path.resolve(raw);
  const literalKind = statKind(literal);
  if (literalKind === 'dir') return literal;

  const tried: { resolved: string; kind: Kind }[] = [{ resolved: literal, kind: literalKind }];

  const trimmed = raw.trim();
  if (trimmed !== raw && trimmed.length > 0) {
    const trimmedResolved = path.resolve(trimmed);
    const trimmedKind = statKind(trimmedResolved);
    if (trimmedKind === 'dir') return trimmedResolved;
    tried.push({ resolved: trimmedResolved, kind: trimmedKind });
  }

  const lines: string[] = [`munin ingest: '${raw}' is not a readable directory.`];
  tried.forEach((t, i) => {
    const label = i === 0 ? 'tried' : 'also tried (trimmed)';
    const why = t.kind === 'file' ? 'exists but is a file, not a directory' : 'no such directory';
    lines.push(`  ${label}: ${t.resolved}  (${why})`);
  });
  lines.push('');
  lines.push(PATH_TIPS);
  throw new IngestDirectoryError(lines.join('\n'));
}

// The filesystem connector's directory-read failure carries this phrase
// ("<pkg>: cannot read directory <abs>: <reason>"). Matching on it lets us map
// the raw connector string to friendly guidance without an engine change.
const CONNECTOR_READ_DIR_MARKER = 'cannot read directory';

/**
 * Map the filesystem connector's raw "cannot read directory <abs>: <reason>"
 * error (thrown deep in the walk — see packages/connectors/filesystem/src/index.ts)
 * to the same product-framed guidance, so a directory that vanished or became
 * unreadable AFTER the pre-flight still gets an actionable message instead of a
 * raw connector stack. Returns undefined for any other error.
 */
export function mapConnectorReadError(err: unknown): IngestDirectoryError | undefined {
  if (!(err instanceof Error) || !err.message.includes(CONNECTOR_READ_DIR_MARKER)) {
    return undefined;
  }
  const lines: string[] = [
    'munin ingest: could not read a directory while scanning your folder.',
    `  ${err.message}`,
    '',
    'Check the folder still exists and is readable.',
    PATH_TIPS,
  ];
  return new IngestDirectoryError(lines.join('\n'));
}

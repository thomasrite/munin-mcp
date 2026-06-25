// Default file extensions the filesystem connector ingests.
//
// Two groups:
//   * document formats — handled by the engine's pdf/docx/markdown/txt parsers;
//   * source-code / structured-text formats — handled by the engine's code
//     parser. That list (`CODE_FILE_EXTENSIONS`) lives in the engine and is the
//     single source of truth; we import it rather than duplicate it so the
//     connector's allowlist can never drift from what the pipeline can parse.
//
// IMPORTANT — import the list from the engine's ZERO-DEPENDENCY leaf
// (`@muninhq/engine/ingest/extensions`), NOT the full `@muninhq/engine` barrel. The
// barrel pulls in providers, the query pipeline and PGlite, and routes this
// constant through a multi-hop re-export; importing a leaf constant through that
// heavy, re-exported path is exactly the kind of coupling whose value can come
// back EMPTY under a stale build or bundler scope-hoisting — which would
// silently drop EVERY source file from the default allowlist while the prose
// formats (a local literal, below) kept working. The leaf import is tiny,
// side-effect-free and cycle-proof; and `buildSourceExtensions` fails LOUD if
// the code half is ever empty, so the failure can never be silent again.
//
// Vertical-agnostic: these are universal content types, not domain concepts.

import { CODE_FILE_EXTENSIONS } from '@muninhq/engine/ingest/extensions';

// Prose / document formats with dedicated parsers in the engine.
export const DEFAULT_DOCUMENT_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.docx',
  '.md',
  '.markdown',
  '.txt',
  '.text',
];

// Re-exported for callers that want only the code half (e.g. "ingest my repo,
// not the PDFs in it").
export { CODE_FILE_EXTENSIONS };

// Build the default allowlist (documents + source code), refusing to produce a
// docs-only list if the code half is missing. An empty `CODE_FILE_EXTENSIONS`
// at this point means the engine's extension leaf failed to resolve (a build /
// module-resolution corruption) — ingesting a codebase would then silently
// yield zero source files. Fail fast and diagnosably instead.
export function buildSourceExtensions(
  documentExtensions: readonly string[],
  codeExtensions: readonly string[],
): readonly string[] {
  // Guard empty AND undefined: the reported failure was the engine import
  // resolving "empty/undefined", so keep the diagnostic for both rather than
  // letting an undefined import throw a bare `cannot read 'length'`.
  if (codeExtensions == null || codeExtensions.length === 0) {
    throw new Error(
      '@muninhq/connector-filesystem: CODE_FILE_EXTENSIONS resolved empty — the engine ' +
        "code-extension set ('@muninhq/engine/ingest/extensions') is missing at module load " +
        '(likely a stale build or module-resolution issue). Refusing to fall back to a ' +
        'documents-only allowlist that would silently ingest zero source files.',
    );
  }
  return [...documentExtensions, ...codeExtensions];
}

// The default ingest allowlist: every format the engine can parse. Junk with an
// allowed extension (lockfiles, *.min.js, oversized files, …) is pruned
// separately by the ignore rules — see ignore-rules.ts.
export const DEFAULT_SOURCE_EXTENSIONS: readonly string[] = buildSourceExtensions(
  DEFAULT_DOCUMENT_EXTENSIONS,
  CODE_FILE_EXTENSIONS,
);

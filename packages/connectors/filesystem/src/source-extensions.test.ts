import { describe, expect, it } from 'vitest';

import {
  CODE_FILE_EXTENSIONS,
  DEFAULT_DOCUMENT_EXTENSIONS,
  DEFAULT_SOURCE_EXTENSIONS,
  buildSourceExtensions,
} from './source-extensions';

describe('source-extensions: default ingest allowlist', () => {
  it('imports a NON-EMPTY code-extension set from the engine leaf', () => {
    // The bug this guards against: the engine import resolving empty, which
    // silently strips every source-code format from the default allowlist.
    expect(CODE_FILE_EXTENSIONS.length).toBeGreaterThan(0);
    expect(CODE_FILE_EXTENSIONS).toContain('.ts');
    expect(CODE_FILE_EXTENSIONS).toContain('.py');
  });

  it('DEFAULT_SOURCE_EXTENSIONS is the union of document AND code formats', () => {
    // Documents (a local literal) AND code (imported) — both halves present.
    for (const docExt of DEFAULT_DOCUMENT_EXTENSIONS) {
      expect(DEFAULT_SOURCE_EXTENSIONS).toContain(docExt);
    }
    for (const codeExt of ['.ts', '.tsx', '.py', '.go', '.rs', '.java']) {
      expect(DEFAULT_SOURCE_EXTENSIONS).toContain(codeExt);
    }
    expect(DEFAULT_SOURCE_EXTENSIONS.length).toBe(
      DEFAULT_DOCUMENT_EXTENSIONS.length + CODE_FILE_EXTENSIONS.length,
    );
  });
});

describe('buildSourceExtensions: fail-loud on a missing code half', () => {
  it('returns the union when both halves are present', () => {
    expect(buildSourceExtensions(['.md'], ['.ts', '.py'])).toEqual(['.md', '.ts', '.py']);
  });

  it('THROWS rather than silently producing a documents-only allowlist', () => {
    // This is the regression contract: if the engine code-extension set ever
    // resolves empty (stale build / bad re-export), ingest must fail loudly,
    // never silently drop every source file.
    expect(() => buildSourceExtensions(['.md', '.txt'], [])).toThrow(/resolved empty/i);
  });

  it('THROWS with the same diagnostic when the code half is undefined', () => {
    // The reported failure was "empty/undefined" — an undefined import must
    // keep the diagnostic, not surface as a bare `cannot read 'length'`.
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: simulate a corrupt import resolving to undefined
      buildSourceExtensions(['.md', '.txt'], undefined as any),
    ).toThrow(/resolved empty/i);
  });
});

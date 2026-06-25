// Path pre-flight for `munin ingest`: literal-vs-trimmed resolution (without
// breaking a legitimately space-named directory) and the actionable error /
// connector-ENOENT mapping. Filesystem-only — no DB, no Docker.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IngestDirectoryError, mapConnectorReadError, resolveIngestDirectory } from './ingest-path';

describe('resolveIngestDirectory', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-ingest-path-')));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('returns the resolved absolute path for an existing directory', () => {
    const dir = path.join(base, 'docs');
    fs.mkdirSync(dir);
    const out = resolveIngestDirectory(dir);
    expect(out).toBe(path.resolve(dir));
    expect(fs.statSync(out).isDirectory()).toBe(true);
  });

  it('falls back to the TRIMMED path when the literal (space-padded) one does not exist', () => {
    const dir = path.join(base, 'munin-test');
    fs.mkdirSync(dir);
    // A leading/trailing space the user accidentally pasted: the literal does not
    // resolve, so we trim and find the real directory.
    expect(resolveIngestDirectory(`${dir} `)).toBe(path.resolve(dir));
    expect(resolveIngestDirectory(` ${dir}`)).toBe(path.resolve(dir));
  });

  it('PREFERS the literal path so a legitimately space-named directory still works', () => {
    // A directory whose name really ends in a space — the literal must win over
    // the trimmed variant, never silently resolving to a different folder.
    const spaceNamed = path.join(base, 'UNI Study Guides ');
    fs.mkdirSync(spaceNamed);
    const out = resolveIngestDirectory(spaceNamed);
    expect(out).toBe(path.resolve(spaceNamed));
    expect(out.endsWith(' ')).toBe(true);
  });

  it('throws IngestDirectoryError naming BOTH paths tried + quote/drag tips for a missing dir', () => {
    const missing = path.join(base, 'nope ');
    let thrown: unknown;
    try {
      resolveIngestDirectory(missing);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IngestDirectoryError);
    const msg = (thrown as Error).message;
    // Names the literal path tried...
    expect(msg).toContain(path.resolve(missing));
    expect(msg).toContain('tried:');
    // ...and the trimmed variant, labelled.
    expect(msg).toContain('also tried (trimmed)');
    expect(msg).toContain(path.resolve(missing.trim()));
    // ...and the actionable guidance.
    expect(msg).toMatch(/quotes/i);
    expect(msg).toMatch(/drag the folder/i);
  });

  it('reports a file (not a directory) distinctly', () => {
    const file = path.join(base, 'notes.txt');
    fs.writeFileSync(file, 'hi');
    expect(() => resolveIngestDirectory(file)).toThrow(IngestDirectoryError);
    expect(() => resolveIngestDirectory(file)).toThrow(/file, not a directory/);
  });
});

describe('mapConnectorReadError', () => {
  it('maps the filesystem connector "cannot read directory" ENOENT to friendly guidance', () => {
    const raw = new Error('@muninhq/connector-filesystem: cannot read directory /x/y: ENOENT');
    const mapped = mapConnectorReadError(raw);
    expect(mapped).toBeInstanceOf(IngestDirectoryError);
    // Preserves the original message for diagnosis...
    expect(mapped?.message).toContain('cannot read directory /x/y');
    // ...and adds the same tips footer.
    expect(mapped?.message).toMatch(/quotes/i);
    expect(mapped?.message).toMatch(/drag the folder/i);
  });

  it('returns undefined for an unrelated error', () => {
    expect(mapConnectorReadError(new Error('boom'))).toBeUndefined();
    expect(mapConnectorReadError('not an error')).toBeUndefined();
    expect(mapConnectorReadError(undefined)).toBeUndefined();
  });
});

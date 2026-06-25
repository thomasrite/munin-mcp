// PROTOCOL GUARD (engine-wide): library code must not write to stdout.
//
// The engine is consumed in-process by the read-only MCP server, where stdout
// belongs exclusively to JSON-RPC — one stray stdout write corrupts every
// connected client. Diagnostics in the engine are legitimately written to stderr
// (console.warn / console.error), so this guard bans ONLY the stdout-writing
// console forms (log / info / debug / dir / table) and direct process.stdout in
// library source. Mirrors packages/mcp's no-stdout-guard, scoped to the
// stdout-writing surface because the engine, unlike the MCP package, may log
// diagnostics to stderr. Test files are excluded — they never run in the
// JSON-RPC path.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function libraryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...libraryFiles(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('engine stdout-write guard', () => {
  // Exclude this guard itself — its prose/regexes mention the banned tokens.
  const self = fileURLToPath(import.meta.url);
  const files = libraryFiles(SRC_DIR).filter((f) => f !== self);

  it('scans a plausible library file set', () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it('no stdout-writing console.* in engine library code (diagnostics go to stderr)', () => {
    const stdoutConsole = /\bconsole\s*\.\s*(log|info|debug|dir|table)\b/;
    const offenders = files.filter((f) => stdoutConsole.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it('no direct process.stdout writes in engine library code', () => {
    const offenders = files.filter((f) => /process\s*\.\s*stdout/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });
});

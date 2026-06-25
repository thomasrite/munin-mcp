// PROTOCOL GUARD: stdout belongs to JSON-RPC.
//
// One stray stdout write corrupts every connected MCP client, so this package
// bans console.* entirely (the logger writes to fd 2) and bans direct
// process.stdout use outside the SDK transport. Static scan over every source
// file, mirroring the engine's no-skip/bypass-inventory self-guard style.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('stdout/console guard', () => {
  // Exclude this guard itself — its prose/regexes mention the banned tokens.
  const self = fileURLToPath(import.meta.url);
  const files = sourceFiles(SRC_DIR).filter((f) => f !== self);

  it('scans a plausible file set', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('no console.* anywhere in the package (logging goes to stderr via pino)', () => {
    const offenders = files.filter((f) => /\bconsole\s*\.\s*\w+/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it('no direct process.stdout writes outside the SDK transport', () => {
    const offenders = files.filter((f) => /process\s*\.\s*stdout/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });
});

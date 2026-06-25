// ZERO-BYPASS GUARD (mirrors the engine's bypass-inventory discipline).
//
// The MCP server is a USER request path: every read runs under the
// single-user RegularReadContext. The engine's internal-bypass token is for
// system jobs only — it must never appear in this package. Static scan,
// fail-closed (the banned token is assembled below so this file stays clean).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
// Split so this guard file does not match its own banned token.
const BANNED = ['internal', 'Bypass'].join('');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('zero-bypass guard', () => {
  it(`no source file in packages/mcp mentions ${BANNED}`, () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((f) => path.basename(f) !== path.basename(fileURLToPath(import.meta.url)))
      .filter((f) => readFileSync(f, 'utf8').includes(BANNED));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it(`no kind:'bypass' context is constructed in packages/mcp`, () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((f) => path.basename(f) !== path.basename(fileURLToPath(import.meta.url)))
      .filter((f) => /kind:\s*['"]bypass['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { chunkBlocks } from './chunker';
import { sanitiseText } from './text-sanitise';

// Build control chars via fromCharCode so no raw control byte lives in source.
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);

describe('sanitiseText', () => {
  it('strips the NUL byte (which Postgres TEXT cannot store)', () => {
    expect(sanitiseText(`a${NUL}b`)).toBe('ab');
    expect(sanitiseText(`${NUL}lead`)).toBe('lead');
    expect(sanitiseText(`trail${NUL}`)).toBe('trail');
  });

  it('strips other C0 control characters and DEL', () => {
    expect(sanitiseText(`x${BEL}y${DEL}z`)).toBe('xyz');
  });

  it('preserves common whitespace controls (tab, newline, carriage return)', () => {
    expect(sanitiseText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('leaves ordinary text untouched and is idempotent', () => {
    const clean = 'Ordinary prose — with punctuation, 123.';
    expect(sanitiseText(clean)).toBe(clean);
    expect(sanitiseText(sanitiseText(`a${NUL}b`))).toBe('ab');
  });
});

describe('chunkBlocks NUL handling', () => {
  it('produces chunk text with the NUL removed rather than carrying it through', () => {
    const structure = { headingPath: [] as string[] };
    const chunks = chunkBlocks([{ text: `Hello${NUL} world.`, structure }]);
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.map((c) => c.text).join(' ');
    expect(joined).not.toContain(NUL);
    expect(joined).toContain('Hello world');
  });
});

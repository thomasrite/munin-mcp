import { describe, expect, it } from 'vitest';

import { detectFromBytes, detectFromFilename } from './mime-detection';

describe('detectFromFilename', () => {
  it('maps common extensions', () => {
    expect(detectFromFilename('foo.pdf').mimeType).toBe('application/pdf');
    expect(detectFromFilename('foo.PDF').mimeType).toBe('application/pdf');
    expect(detectFromFilename('foo.docx').mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(detectFromFilename('foo.md').mimeType).toBe('text/markdown');
    expect(detectFromFilename('foo.markdown').mimeType).toBe('text/markdown');
    expect(detectFromFilename('foo.txt').mimeType).toBe('text/plain');
  });

  it('returns undefined for unknown extension', () => {
    expect(detectFromFilename('foo.heic').mimeType).toBeUndefined();
    expect(detectFromFilename('foo').mimeType).toBeUndefined();
    expect(detectFromFilename('foo').extension).toBeUndefined();
  });
});

describe('detectFromBytes', () => {
  it('detects PDF by magic bytes', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(detectFromBytes(pdf).mimeType).toBe('application/pdf');
  });

  it('detects DOCX (zip) by magic bytes', () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(detectFromBytes(docx).mimeType).toContain('wordprocessingml');
  });

  it('detects plain text from printability', () => {
    const bytes = new TextEncoder().encode('hello world, this is just text');
    expect(detectFromBytes(bytes).mimeType).toBe('text/plain');
  });

  it('returns undefined for binary noise', () => {
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i % 256));
    expect(detectFromBytes(bytes).mimeType).toBeUndefined();
  });
});

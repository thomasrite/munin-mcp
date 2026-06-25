// Code-skip filtering for `munin extract`: source-code paragraphs are dropped
// before extraction (code yields ~no entities under a prose schema). Pure logic
// — no DB, no Docker; exercises the CLI-tier filter over the pending list.

import { describe, expect, it } from 'vitest';

import { isCodeDocument, partitionPendingByCode } from './extract-cli';

describe('isCodeDocument', () => {
  it('detects source-code extensions', () => {
    for (const ext of ['.ts', '.py', '.go', '.sql', '.rs', '.java']) {
      expect(isCodeDocument({ title: `file${ext}`, externalId: `src/file${ext}` })).toBe(true);
    }
  });

  it('treats prose/document formats as NOT code', () => {
    for (const ext of ['.md', '.pdf', '.txt', '.docx', '.markdown']) {
      expect(isCodeDocument({ title: `file${ext}`, externalId: `file${ext}` })).toBe(false);
    }
  });

  it('prefers externalId, falls back to title, and is case-insensitive', () => {
    // externalId (the connector's file path) wins over a misleading title.
    expect(isCodeDocument({ title: 'readme.md', externalId: 'src/main.ts' })).toBe(true);
    // externalId null → use the title.
    expect(isCodeDocument({ title: 'src/main.ts', externalId: null })).toBe(true);
    // Uppercase extension still matches.
    expect(isCodeDocument({ title: 'Main.TS', externalId: null })).toBe(true);
  });
});

describe('partitionPendingByCode', () => {
  const docs = [
    { id: 'd-md', title: 'notes.md', externalId: 'notes.md' },
    { id: 'd-ts', title: 'main.ts', externalId: 'src/main.ts' },
  ];

  it('keeps prose paragraphs, drops code-derived ones, and counts the skips', () => {
    const pending = [
      { id: 'p1', documentId: 'd-md' },
      { id: 'p2', documentId: 'd-ts' },
      { id: 'p3', documentId: 'd-md' },
    ];
    const { keep, skippedCodeCount } = partitionPendingByCode(pending, docs);
    expect(keep.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(skippedCodeCount).toBe(1);
  });

  it('skips nothing when every document is prose', () => {
    const pending = [{ id: 'p1', documentId: 'd-md' }];
    const { keep, skippedCodeCount } = partitionPendingByCode(pending, [docs[0]!]);
    expect(keep.map((p) => p.id)).toEqual(['p1']);
    expect(skippedCodeCount).toBe(0);
  });

  it('skips everything when every document is code', () => {
    const pending = [
      { id: 'p1', documentId: 'd-ts' },
      { id: 'p2', documentId: 'd-ts' },
    ];
    const { keep, skippedCodeCount } = partitionPendingByCode(pending, [docs[1]!]);
    expect(keep).toEqual([]);
    expect(skippedCodeCount).toBe(2);
  });

  it('keeps a paragraph whose document is unknown (never silently dropped)', () => {
    const pending = [{ id: 'p1', documentId: 'd-missing' }];
    const { keep, skippedCodeCount } = partitionPendingByCode(pending, docs);
    expect(keep.map((p) => p.id)).toEqual(['p1']);
    expect(skippedCodeCount).toBe(0);
  });
});

// Pure unit tests for `munin forget` (Stage B): the read-only preview, the
// renderers, the arg parser, and — the safety property — that the default path
// previews WITHOUT deleting while --commit + a matching --confirm-title is the
// only thing that reaches eraseDocument. No store, no Docker, no engine call:
// the orchestrator's seams are injected.

import { describe, expect, it, vi } from 'vitest';

import type {
  Document,
  ErasureReceipt,
  GraphStore,
  GraphStoreReader,
  RegularReadContext,
} from '@muninhq/engine';
import { asTenantId } from '@muninhq/engine';
import type { Configuration } from '@muninhq/shared';

import {
  type ForgetDeps,
  buildForgetReadContext,
  formatForgetPreview,
  formatForgetReceipt,
  parseForgetArgs,
  previewErase,
  runForget,
} from './munin-forget';

const DOC_ID = 'dddddddd-0000-4000-8000-000000000001';

function config(): Configuration {
  return {
    id: 'c',
    version: '1',
    entityTypes: [],
    relationshipTypes: [],
    terminology: {},
    roles: [{ name: 'owner', description: 'owner', baseTags: ['personal'] }],
    tagExpansion: (tags) => [...new Set(tags)],
    queryTemplates: [],
    connectors: [],
  };
}

// A document with just the fields the preview reads.
function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: DOC_ID as Document['id'],
    tenantId: asTenantId('t-1'),
    externalId: '/home/me/notes/q4.md',
    connectorPackage: '@muninhq/connector-filesystem',
    title: 'Q4 Planning Notes',
    mimeType: 'text/markdown',
    byteSize: null,
    sha256: null,
    blobStorageUri: 'documents/dddddddd/q4.md',
    sourceModifiedAt: null,
    versionGroupId: null,
    versionSeq: null,
    supersedesDocumentId: null,
    validFrom: null,
    validTo: null,
    sensitivityClassId: null,
    accessTags: ['personal'],
    createdBy: 'system' as Document['createdBy'],
    createdAt: new Date('2026-06-20T09:30:00.000Z'),
    updatedAt: new Date('2026-06-20T09:30:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

// A reader stub: getDocument + the two derived-row readers the preview uses.
function readerStub(opts: {
  document: Document | null;
  paragraphs?: number;
  entities?: number;
}): GraphStoreReader {
  const paragraphs = Array.from({ length: opts.paragraphs ?? 0 }, (_, i) => ({ id: `p-${i}` }));
  const entities = Array.from({ length: opts.entities ?? 0 }, (_, i) => ({ id: `e-${i}` }));
  return {
    getDocument: vi.fn(async () => opts.document),
    findParagraphsByDocument: vi.fn(async () => paragraphs),
    findEntitiesByParagraphIds: vi.fn(async () => entities),
  } as unknown as GraphStoreReader;
}

function receipt(overrides: Partial<ErasureReceipt> = {}): ErasureReceipt {
  return {
    documentId: DOC_ID as ErasureReceipt['documentId'],
    tenantId: asTenantId('t-1'),
    blobUri: 'documents/dddddddd/q4.md',
    deletedCounts: {
      embeddings: 12,
      entities: 4,
      edges: 3,
      paragraphs: 6,
      citationEvents: 2,
      duplicates: 1,
      reviewItems: 0,
    },
    occurredAt: new Date('2026-06-24T00:00:00.000Z'),
    actor: 'cli:forget' as ErasureReceipt['actor'],
    blobDeleted: true,
    fullyErased: true,
    ...overrides,
  };
}

// Build injected deps around a reader stub and a spy erase; close is a no-op.
function deps(opts: {
  reader: GraphStoreReader;
  erase?: ForgetDeps['erase'];
  log?: (l: string) => void;
  logError?: (l: string) => void;
}): { deps: ForgetDeps; eraseSpy: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  const eraseSpy = vi.fn(opts.erase ?? (async () => receipt()));
  return {
    eraseSpy,
    close,
    deps: {
      openStore: async () => ({ store: opts.reader as unknown as GraphStore, close }),
      loadBlobStorage: () => ({}) as never,
      loadConfiguration: async () => config(),
      erase: eraseSpy as unknown as ForgetDeps['erase'],
      log: opts.log ?? (() => {}),
      logError: opts.logError ?? (() => {}),
    },
  };
}

describe('parseForgetArgs', () => {
  it('takes the first bare token as the document id (dry-run by default)', () => {
    expect(parseForgetArgs([DOC_ID])).toEqual({ documentId: DOC_ID, commit: false });
  });

  it('reads --commit and --confirm-title, and never mistakes a flag value for the id', () => {
    expect(
      parseForgetArgs([
        '--tenant',
        't-1',
        DOC_ID,
        '--commit',
        '--confirm-title',
        'Q4 Planning Notes',
      ]),
    ).toEqual({ documentId: DOC_ID, commit: true, confirmTitle: 'Q4 Planning Notes' });
  });

  it('does not treat the --home value as the document id', () => {
    expect(parseForgetArgs(['--home', '/srv/m', DOC_ID])).toEqual({
      documentId: DOC_ID,
      commit: false,
    });
  });

  it('returns no documentId when none was given', () => {
    expect(parseForgetArgs(['--commit'])).toEqual({ documentId: undefined, commit: true });
  });
});

describe('buildForgetReadContext', () => {
  it('is a regular (never bypass) context attributed to cli:forget', async () => {
    const ctx = await buildForgetReadContext(config(), asTenantId('t-1'));
    expect(ctx.kind).toBe('regular');
    expect(ctx.actor).toBe('cli:forget');
    expect(ctx.accessTags).toEqual(['personal']);
  });
});

describe('previewErase', () => {
  const ctx = { kind: 'regular' } as RegularReadContext;

  it('counts paragraphs (exact) and entities (best-effort) for a visible document', async () => {
    const reader = readerStub({ document: doc(), paragraphs: 6, entities: 4 });
    const preview = await previewErase(reader, ctx, DOC_ID as Parameters<typeof previewErase>[2]);
    expect(preview).not.toBeNull();
    expect(preview?.title).toBe('Q4 Planning Notes');
    expect(preview?.path).toBe('/home/me/notes/q4.md');
    expect(preview?.blobUri).toBe('documents/dddddddd/q4.md');
    expect(preview?.paragraphCount).toBe(6);
    expect(preview?.entityCount).toBe(4);
    expect(preview?.superseded).toBe(false);
  });

  it('returns null when the document is missing or invisible', async () => {
    const reader = readerStub({ document: null });
    expect(
      await previewErase(reader, ctx, DOC_ID as Parameters<typeof previewErase>[2]),
    ).toBeNull();
  });

  it('flags a superseded version', async () => {
    const reader = readerStub({ document: doc({ validTo: new Date() }), paragraphs: 1 });
    const preview = await previewErase(reader, ctx, DOC_ID as Parameters<typeof previewErase>[2]);
    expect(preview?.superseded).toBe(true);
  });
});

describe('formatForgetPreview', () => {
  it('names the document, counts, blob, and the exact --commit command', () => {
    const out = formatForgetPreview({
      documentId: DOC_ID,
      title: 'Q4 Planning Notes',
      path: '/home/me/notes/q4.md',
      blobUri: 'documents/dddddddd/q4.md',
      accessTags: ['personal'],
      superseded: false,
      ingestedAt: new Date('2026-06-20T09:30:00.000Z'),
      paragraphCount: 6,
      entityCount: 4,
    });
    expect(out).toContain(
      'would erase: "Q4 Planning Notes" (dddddddd-0000-4000-8000-000000000001)',
    );
    expect(out).toContain('paragraphs:  6 (exact)');
    expect(out).toContain('entities:    4 (best-effort');
    expect(out).toContain('documents/dddddddd/q4.md');
    expect(out).toContain('This is a DRY RUN — nothing was deleted.');
    expect(out).toContain(
      'munin forget dddddddd-0000-4000-8000-000000000001 --commit --confirm-title "Q4 Planning Notes"',
    );
  });
});

describe('formatForgetReceipt', () => {
  it('renders the cascade counts and the fully-erased line', () => {
    const out = formatForgetReceipt(receipt(), 'Q4 Planning Notes');
    expect(out).toContain('Erased "Q4 Planning Notes"');
    expect(out).toContain('paragraphs:      6');
    expect(out).toContain('embeddings:      12');
    expect(out).toContain('blob:            deleted (verified gone)');
    expect(out).toContain('Document fully erased — its rows and the blob are gone.');
  });

  it('reports a NOT-confirmed blob as flagged for retry', () => {
    const out = formatForgetReceipt(
      receipt({ blobDeleted: false, fullyErased: false, blobError: 'still present' }),
      'Q4 Planning Notes',
    );
    expect(out).toContain('NOT confirmed gone — flagged for retry (still present)');
    expect(out).toContain('flagged for retry.');
  });
});

describe('runForget (the safety property)', () => {
  const base = { configPackage: '@x/config', tenantId: 't-1', env: {} as NodeJS.ProcessEnv };

  it('DRY RUN by default: previews and NEVER calls eraseDocument', async () => {
    const logs: string[] = [];
    const reader = readerStub({ document: doc(), paragraphs: 6, entities: 4 });
    const { deps: d, eraseSpy, close } = deps({ reader, log: (l) => logs.push(l) });
    const result = await runForget({ ...base, documentId: DOC_ID, commit: false }, d);
    expect(result.outcome).toBe('previewed');
    expect(result.exitCode).toBe(0);
    expect(eraseSpy).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('This is a DRY RUN');
    expect(close).toHaveBeenCalledOnce();
  });

  it('--commit WITHOUT --confirm-title refuses and does NOT erase', async () => {
    const reader = readerStub({ document: doc(), paragraphs: 6 });
    const { deps: d, eraseSpy } = deps({ reader });
    const result = await runForget({ ...base, documentId: DOC_ID, commit: true }, d);
    expect(result.outcome).toBe('confirm-required');
    expect(result.exitCode).toBe(1);
    expect(eraseSpy).not.toHaveBeenCalled();
  });

  it('--commit with a MISMATCHED title refuses and does NOT erase', async () => {
    const reader = readerStub({ document: doc(), paragraphs: 6 });
    const { deps: d, eraseSpy } = deps({ reader });
    const result = await runForget(
      { ...base, documentId: DOC_ID, commit: true, confirmTitle: 'Wrong Title' },
      d,
    );
    expect(result.outcome).toBe('confirm-mismatch');
    expect(eraseSpy).not.toHaveBeenCalled();
  });

  it('--commit with the EXACT title calls eraseDocument once and prints the receipt', async () => {
    const logs: string[] = [];
    const reader = readerStub({ document: doc(), paragraphs: 6, entities: 4 });
    const { deps: d, eraseSpy } = deps({ reader, log: (l) => logs.push(l) });
    const result = await runForget(
      { ...base, documentId: DOC_ID, commit: true, confirmTitle: 'Q4 Planning Notes' },
      d,
    );
    expect(result.outcome).toBe('erased');
    expect(result.exitCode).toBe(0);
    expect(eraseSpy).toHaveBeenCalledOnce();
    // The erase was attributed to the cli:forget actor on the caller's tenant.
    const [, ctxArg, idArg] = eraseSpy.mock.calls[0] as [unknown, { actor: string }, string];
    expect(ctxArg.actor).toBe('cli:forget');
    expect(idArg).toBe(DOC_ID);
    expect(logs.join('\n')).toContain('Erased "Q4 Planning Notes"');
  });

  it('a missing document erases nothing', async () => {
    const reader = readerStub({ document: null });
    const { deps: d, eraseSpy } = deps({ reader });
    const result = await runForget(
      { ...base, documentId: DOC_ID, commit: true, confirmTitle: 'whatever' },
      d,
    );
    expect(result.outcome).toBe('not-found');
    expect(eraseSpy).not.toHaveBeenCalled();
  });

  it('a not-fully-erased receipt (blob flagged) exits non-zero', async () => {
    const reader = readerStub({ document: doc(), paragraphs: 6 });
    const { deps: d } = deps({
      reader,
      erase: async () => receipt({ blobDeleted: false, fullyErased: false }),
    });
    const result = await runForget(
      { ...base, documentId: DOC_ID, commit: true, confirmTitle: 'Q4 Planning Notes' },
      d,
    );
    expect(result.outcome).toBe('erased');
    expect(result.exitCode).toBe(1);
  });
});

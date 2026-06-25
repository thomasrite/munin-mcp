// Pure unit tests for `munin status` (Stage B): the corpus computation over the
// frozen readers (counts, the paragraph cap, recent docs), the env-derived
// posture, and the renderer. No store, no Docker — the reader is a stub.

import { describe, expect, it, vi } from 'vitest';

import type { GraphStoreReader, RegularReadContext } from '@muninhq/engine';
import { asTenantId } from '@muninhq/engine';
import type { Configuration } from '@muninhq/shared';

import {
  type CorpusStatus,
  computeCorpusStatus,
  derivePosture,
  formatStatus,
} from './munin-status';

function config(): Configuration {
  return {
    id: 'generic-baseline',
    version: '2',
    entityTypes: [],
    relationshipTypes: [],
    terminology: {},
    roles: [{ name: 'owner', description: 'owner', baseTags: ['personal'] }],
    tagExpansion: (tags) => [...new Set(tags)],
    queryTemplates: [],
    connectors: [],
  };
}

const ctx = { kind: 'regular', tenantId: asTenantId('tenant-1') } as RegularReadContext;

// A reader stub: findDocuments (paged), getGraphStats, pending, per-doc paragraphs.
function readerStub(opts: {
  total: number;
  perDocParagraphs?: number;
  entities?: number;
  edges?: number;
  pending?: number;
  recent?: Array<{ id: string; title: string; createdAt: Date }>;
}): GraphStoreReader {
  const recent =
    opts.recent ??
    Array.from({ length: Math.min(opts.total, 10) }, (_, i) => ({
      id: `doc-${i}`,
      title: `Document ${i}`,
      createdAt: new Date('2026-06-20T00:00:00.000Z'),
    }));
  return {
    findDocuments: vi.fn(async (_c: unknown, q: { limit: number; offset?: number }) => {
      const offset = q.offset ?? 0;
      // Page over a synthetic corpus of `total` documents for the paragraph walk.
      const items =
        offset === 0
          ? recent
          : Array.from({ length: Math.max(0, Math.min(q.limit, opts.total - offset)) }, (_, i) => ({
              id: `doc-${offset + i}`,
              title: `Document ${offset + i}`,
              createdAt: new Date('2026-06-20T00:00:00.000Z'),
            }));
      return { items, total: opts.total };
    }),
    getGraphStats: vi.fn(async () => ({
      entitiesByType: [],
      totalEntities: opts.entities ?? 0,
      totalEdges: opts.edges ?? 0,
    })),
    findParagraphsPendingExtraction: vi.fn(async () =>
      Array.from({ length: opts.pending ?? 0 }, (_, i) => ({ id: `p-${i}` })),
    ),
    findParagraphsByDocument: vi.fn(async () =>
      Array.from({ length: opts.perDocParagraphs ?? 0 }, (_, i) => ({ id: `q-${i}` })),
    ),
  } as unknown as GraphStoreReader;
}

describe('computeCorpusStatus', () => {
  it('reports document/entity/edge/pending counts and recent docs', async () => {
    const reader = readerStub({
      total: 2,
      perDocParagraphs: 3,
      entities: 17,
      edges: 9,
      pending: 4,
      recent: [
        { id: 'd-1', title: 'Newest', createdAt: new Date('2026-06-20T00:00:00.000Z') },
        { id: 'd-2', title: 'Older', createdAt: new Date('2026-05-01T00:00:00.000Z') },
      ],
    });
    const status = await computeCorpusStatus(reader, ctx, {
      configuration: config(),
      schemaHash: 'h',
    });
    expect(status.tenantId).toBe('tenant-1');
    expect(status.configuration).toEqual({ id: 'generic-baseline', version: '2' });
    expect(status.documentCount).toBe(2);
    expect(status.paragraphCount).toBe(6); // 2 docs × 3 paragraphs
    expect(status.entityCount).toBe(17);
    expect(status.edgeCount).toBe(9);
    expect(status.paragraphsPendingExtraction).toBe(4);
    expect(status.recentDocuments.map((d) => d.title)).toEqual(['Newest', 'Older']);
  });

  it('does not count paragraphs beyond the cap (reports null, no silent cap)', async () => {
    const reader = readerStub({ total: 2_001, perDocParagraphs: 1 });
    const status = await computeCorpusStatus(reader, ctx, {
      configuration: config(),
      schemaHash: 'h',
    });
    expect(status.documentCount).toBe(2_001);
    expect(status.paragraphCount).toBeNull();
    // The expensive per-document paragraph walk never ran.
    expect(reader.findParagraphsByDocument).not.toHaveBeenCalled();
  });

  it('an empty corpus is all-zero with no recent docs', async () => {
    const reader = readerStub({ total: 0 });
    const status = await computeCorpusStatus(reader, ctx, {
      configuration: config(),
      schemaHash: 'h',
    });
    expect(status.documentCount).toBe(0);
    expect(status.paragraphCount).toBe(0);
    expect(status.recentDocuments).toEqual([]);
  });
});

describe('derivePosture', () => {
  it('reads fully-local zero-egress mode', () => {
    const p = derivePosture(
      { GRAPH_STORE: 'local', MUNIN_LOCAL_MODE: 'true', LLM_PROVIDER: 'ollama' },
      '/Users/me/.munin',
    );
    expect(p.storeBackend).toBe('local (PGlite)');
    expect(p.mode).toContain('zero egress');
    expect(p.llmProvider).toBe('ollama');
    expect(p.embeddingProvider).toBe('(default)');
    expect(p.home).toBe('/Users/me/.munin');
  });

  it('reads local-store + cloud-AI mode', () => {
    const p = derivePosture(
      { GRAPH_STORE: 'local', MUNIN_ALLOW_CLOUD_PROVIDERS: 'true', EMBEDDING_PROVIDER: 'openai' },
      '/h',
    );
    expect(p.mode).toContain('local store + cloud AI');
    expect(p.embeddingProvider).toBe('openai');
  });

  it('defaults to a postgres backend with an undeclared posture', () => {
    const p = derivePosture({}, '/h');
    expect(p.storeBackend).toBe('postgres');
    expect(p.mode).toBe('not declared');
  });
});

describe('formatStatus', () => {
  const status: CorpusStatus = {
    tenantId: 'tenant-1',
    configuration: { id: 'generic-baseline', version: '2' },
    documentCount: 3,
    paragraphCount: 42,
    entityCount: 17,
    edgeCount: 9,
    paragraphsPendingExtraction: 4,
    recentDocuments: [
      { documentId: 'd-1', title: 'Q4 Notes', ingestedAt: new Date('2026-06-20T09:30:00.000Z') },
    ],
  };
  const posture = derivePosture(
    { GRAPH_STORE: 'local', MUNIN_LOCAL_MODE: 'true', LLM_PROVIDER: 'ollama' },
    '/Users/me/.munin',
  );

  it('renders the header, posture, every count, and recent docs', () => {
    const out = formatStatus(status, posture);
    expect(out).toContain('Munin memory — /Users/me/.munin (tenant tenant-1)');
    expect(out).toContain('configuration: generic-baseline v2');
    expect(out).toContain('store:         local (PGlite)');
    expect(out).toContain('posture:       fully local — zero egress (MUNIN_LOCAL_MODE=true)');
    expect(out).toContain('providers:     LLM=ollama  EMBEDDING=(default)');
    expect(out).toContain('documents:           3');
    expect(out).toContain('paragraphs:          42');
    expect(out).toContain('entities:            17');
    expect(out).toContain('edges:               9');
    expect(out).toContain('pending extraction:  4 paragraph(s)');
    expect(out).toContain('run `munin extract`'); // shown because pending > 0
    expect(out).toContain('Q4 Notes');
    expect(out).toContain('d-1  ingested 2026-06-20');
  });

  it('shows the cap message when paragraphs were not counted', () => {
    const out = formatStatus({ ...status, paragraphCount: null }, posture);
    expect(out).toContain('not counted — over 2000 documents');
  });

  it('renders an empty corpus with a helpful next step and no pending hint', () => {
    const out = formatStatus(
      { ...status, documentCount: 0, paragraphCount: 0, recentDocuments: [] },
      posture,
    );
    expect(out).toContain('Corpus is empty');
    expect(out).toContain('munin ingest');
    expect(out).not.toContain('pending extraction');
  });
});

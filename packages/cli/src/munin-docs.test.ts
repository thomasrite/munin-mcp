// Pure helpers for `munin docs` (S2 deliverable 3): the single-user read
// context and the listing renderer. The store-opening orchestrator (runDocsList)
// is exercised by the int suite; here we prove the fail-closed context and the
// rendering, including the erase reference and the empty-corpus case.

import { describe, expect, it } from 'vitest';

import { asTenantId } from '@muninhq/engine';
import type { Configuration } from '@muninhq/shared';

import {
  type DocsListView,
  MAX_DOCS_LIMIT,
  buildLocalReadContext,
  formatDocsList,
  parseDocsLimit,
  singleUserBaseTags,
} from './munin-docs';

function config(roles: { name: string; baseTags: string[] }[]): Configuration {
  return {
    id: 'c',
    version: '1',
    entityTypes: [],
    relationshipTypes: [],
    terminology: {},
    roles: roles.map((r) => ({ name: r.name, description: r.name, baseTags: r.baseTags })),
    tagExpansion: (tags) => [...new Set(tags)],
    queryTemplates: [],
    connectors: [],
  };
}

describe('singleUserBaseTags', () => {
  it('unions baseTags across every role, de-duplicated', () => {
    const tags = singleUserBaseTags(
      config([
        { name: 'a', baseTags: ['personal', 'shared'] },
        { name: 'b', baseTags: ['shared', 'work'] },
      ]),
    );
    expect([...tags].sort()).toEqual(['personal', 'shared', 'work']);
  });
});

describe('buildLocalReadContext', () => {
  it('is a regular (never bypass) context with the expanded union tags', async () => {
    const ctx = await buildLocalReadContext(
      config([{ name: 'owner', baseTags: ['personal'] }]),
      asTenantId('t-1'),
    );
    expect(ctx.kind).toBe('regular');
    expect(ctx.tenantId).toBe('t-1');
    expect(ctx.accessTags).toEqual(['personal']);
    expect(ctx.actor).toBe('cli:local-user');
  });

  it('passes the configuration tagExpansion through (hierarchy lives in config)', async () => {
    const cfg = config([{ name: 'owner', baseTags: ['dept:finance'] }]);
    const expanding: Configuration = {
      ...cfg,
      tagExpansion: (tags) => [...tags, ...tags.map((t) => `${t}:read`)],
    };
    const ctx = await buildLocalReadContext(expanding, asTenantId('t-1'));
    expect(ctx.accessTags).toEqual(['dept:finance', 'dept:finance:read']);
  });
});

describe('parseDocsLimit', () => {
  it('accepts a positive integer', () => {
    expect(parseDocsLimit('10')).toBe(10);
    expect(parseDocsLimit('  25 ')).toBe(25);
  });

  it('rejects trailing garbage (never silently reads 50 from "50abc")', () => {
    expect(() => parseDocsLimit('50abc')).toThrow(/positive integer/);
    expect(() => parseDocsLimit('abc')).toThrow(/positive integer/);
    expect(() => parseDocsLimit('')).toThrow(/positive integer/);
  });

  it('rejects zero and over-max rather than silently capping', () => {
    expect(() => parseDocsLimit('0')).toThrow(/at least 1/);
    expect(() => parseDocsLimit(String(MAX_DOCS_LIMIT + 1))).toThrow(/at most/);
    expect(parseDocsLimit(String(MAX_DOCS_LIMIT))).toBe(MAX_DOCS_LIMIT);
  });
});

describe('formatDocsList', () => {
  const base: DocsListView = {
    home: '/Users/you/.munin',
    tenantId: 'tenant-1',
    total: 2,
    documents: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        title: 'Q4 Planning Notes',
        ingestedAt: new Date('2026-06-20T09:30:00.000Z'),
        accessTags: ['personal'],
        superseded: false,
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        title: 'Old Draft',
        ingestedAt: new Date('2026-05-01T00:00:00.000Z'),
        accessTags: ['personal'],
        superseded: true,
      },
    ],
  };

  it('renders each document with id, title, day-precision date and tags', () => {
    const out = formatDocsList(base);
    expect(out).toContain('Munin memory — /Users/you/.munin (tenant tenant-1)');
    expect(out).toContain('2 documents, newest first:');
    expect(out).toContain('Q4 Planning Notes');
    expect(out).toContain(
      'aaaaaaaa-0000-4000-8000-000000000001  ingested 2026-06-20  tags: personal',
    );
    // Superseded versions are flagged honestly.
    expect(out).toContain('Old Draft  [superseded]');
  });

  it('references the erase paths (CLI forget + web admin) and the get_document read path', () => {
    const out = formatDocsList(base);
    expect(out).toContain('munin forget <id>');
    expect(out).toContain('/admin/erase');
    expect(out).toContain('munin_get_document');
  });

  it('notes when the page shows fewer than the total', () => {
    const out = formatDocsList({ ...base, total: 50 });
    expect(out).toContain('50 documents, showing 2, newest first:');
  });

  it('handles an empty corpus with a helpful next step', () => {
    const out = formatDocsList({ ...base, total: 0, documents: [] });
    expect(out).toContain('No documents yet');
    expect(out).toContain('munin ingest');
  });
});

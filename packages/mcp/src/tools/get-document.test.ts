// munin_get_document input hygiene: a malformed id never reaches the store and
// returns the SAME clean not_found as an unknown/invisible one.

import { describe, expect, it } from 'vitest';

import { getDocument } from './get-document';
import type { ToolDeps } from './types';

function depsWithExplodingStore(): ToolDeps {
  return {
    store: {
      getDocumentsByIds: () => {
        throw new Error('store should not be reached for a malformed id');
      },
    },
    context: { kind: 'regular' },
  } as never;
}

describe('getDocument id validation', () => {
  it('returns clean not_found for a non-UUID id without touching the store', async () => {
    const result = await getDocument(depsWithExplodingStore(), {
      documentId: 'not-a-uuid; DROP TABLE',
    });
    expect(result.status).toBe('not_found');
    if (result.status === 'not_found') {
      expect(result.message).toMatch(/not found or not accessible/);
    }
  });

  it('accepts a well-formed UUID and returns not_found when the store yields nothing', async () => {
    const deps = {
      store: { getDocumentsByIds: () => Promise.resolve([]) },
      context: { kind: 'regular' },
    } as never as ToolDeps;
    const result = await getDocument(deps, {
      documentId: '00000000-0000-4000-8000-00000000aaaa',
    });
    expect(result.status).toBe('not_found');
  });
});

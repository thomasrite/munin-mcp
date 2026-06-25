import { describe, expect, it } from 'vitest';

import { resolveExtractionModelId } from './extraction-model';

// The EXTRACTION_MODEL knob's env semantics, isolated. The entry-point wiring
// (worker / CLI / web) is proven in extract-model-knob.test.ts — this file pins
// only the read: SET → trimmed value, UNSET/empty/whitespace → undefined
// (provider default, so the fully-local Ollama path stays unaffected).
describe('resolveExtractionModelId', () => {
  it('returns the trimmed value when EXTRACTION_MODEL is set', () => {
    expect(resolveExtractionModelId({ EXTRACTION_MODEL: 'claude-haiku-4-5-20251001' })).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(resolveExtractionModelId({ EXTRACTION_MODEL: '  some-model  ' })).toBe('some-model');
  });

  it('returns undefined when EXTRACTION_MODEL is unset', () => {
    expect(resolveExtractionModelId({})).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(resolveExtractionModelId({ EXTRACTION_MODEL: '' })).toBeUndefined();
  });

  it('returns undefined for a whitespace-only value', () => {
    expect(resolveExtractionModelId({ EXTRACTION_MODEL: '   ' })).toBeUndefined();
  });
});

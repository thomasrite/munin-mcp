// Unit test for classifyRegion — the pure on-device / cloud / stub mapping that
// the tenant-scoped egress readers (listLlmCalls / summariseLlmCalls) apply to
// each llm_calls `region` tag. No DB; runs in the fast unit suite.

import { describe, expect, it } from 'vitest';

import { classifyRegion } from './postgres-graph-store';

describe('classifyRegion', () => {
  it("maps the on-device provider tag 'local' to on_device", () => {
    expect(classifyRegion('local')).toBe('on_device');
  });

  it("maps the zero-spend test provider tag 'stub' to stub", () => {
    expect(classifyRegion('stub')).toBe('stub');
  });

  it('maps every other (off-device) region to cloud', () => {
    // The real cloud regions/tags the engine's providers stamp today.
    for (const region of ['eu-west-2', 'anthropic-api-us', 'openai-api-us', 'us-east-1']) {
      expect(classifyRegion(region)).toBe('cloud');
    }
  });

  it('treats an unknown/empty region tag as cloud (fail-safe: assume egress)', () => {
    // An unrecognised tag is classified as cloud, never silently on-device — the
    // safe direction for a "did my data leave the device" surface.
    expect(classifyRegion('')).toBe('cloud');
    expect(classifyRegion('some-new-region')).toBe('cloud');
  });
});

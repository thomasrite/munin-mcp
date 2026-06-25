import { describe, expect, it } from 'vitest';

import { sampleConfiguration } from '../test-support/sample-configuration';

import { validateExtractionOutput } from './validation';

describe('validateExtractionOutput — happy paths', () => {
  it('accepts a minimal valid output', () => {
    const result = validateExtractionOutput(
      { entities: [], relationships: [] },
      sampleConfiguration,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a valid entity matching a configured type', () => {
    const result = validateExtractionOutput(
      {
        entities: [{ type: 'Project', properties: { name: 'Atlas' } }],
        relationships: [],
      },
      sampleConfiguration,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a valid relationship between two configured entities', () => {
    const result = validateExtractionOutput(
      {
        entities: [
          { type: 'Project', properties: { name: 'Atlas' } },
          { type: 'Person', properties: { fullName: 'Sarah Chen' } },
        ],
        relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
      },
      sampleConfiguration,
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateExtractionOutput — F63 stringified-array shim (parse-or-leave)', () => {
  const validEntities = [{ type: 'Project', properties: { name: 'Atlas' } }];

  it('parses a stringified valid array and validates it (counter counts each substitution)', () => {
    const result = validateExtractionOutput(
      {
        entities: JSON.stringify(validEntities),
        relationships: JSON.stringify([]),
      },
      sampleConfiguration,
    );
    expect(result.ok).toBe(true);
    expect(result.stringifiedArraysParsed).toBe(2);
    if (result.ok) {
      expect(result.value.entities).toEqual(validEntities);
    }
  });

  it('leaves a stringified OBJECT where an array is expected — validation rejects it', () => {
    const result = validateExtractionOutput(
      { entities: JSON.stringify({ type: 'Project' }), relationships: [] },
      sampleConfiguration,
    );
    expect(result.ok).toBe(false);
    expect(result.stringifiedArraysParsed).toBe(0);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === '$.entities')).toBe(true);
    }
  });

  it('leaves a malformed JSON string — validation rejects it', () => {
    const result = validateExtractionOutput(
      { entities: '[{"type": "Project"', relationships: [] },
      sampleConfiguration,
    );
    expect(result.ok).toBe(false);
    expect(result.stringifiedArraysParsed).toBe(0);
  });

  it('leaves genuine arrays untouched — counter stays 0 and the input is not mutated', () => {
    const input = { entities: validEntities, relationships: [] };
    const result = validateExtractionOutput(input, sampleConfiguration);
    expect(result.ok).toBe(true);
    expect(result.stringifiedArraysParsed).toBe(0);
    expect(input.entities).toBe(validEntities);
  });

  it('never mutates the supplied input object when it does substitute', () => {
    const stringified = JSON.stringify(validEntities);
    const input: Record<string, unknown> = { entities: stringified, relationships: [] };
    const result = validateExtractionOutput(input, sampleConfiguration);
    expect(result.ok).toBe(true);
    expect(result.stringifiedArraysParsed).toBe(1);
    // The repair prompt must see the model's original output — byte-untouched.
    expect(input.entities).toBe(stringified);
  });

  it('does not coerce string-typed properties that merely contain JSON (no coercion creep)', () => {
    // Project.name is schema type 'string'; a JSON-array-looking value must
    // stay a string — the shim is driven by the TOOL schema's top-level array
    // properties only.
    const result = validateExtractionOutput(
      {
        entities: [{ type: 'Project', properties: { name: '["Atlas"]' } }],
        relationships: [],
      },
      sampleConfiguration,
    );
    expect(result.ok).toBe(true);
    expect(result.stringifiedArraysParsed).toBe(0);
    if (result.ok) {
      expect(result.value.entities[0]?.properties.name).toBe('["Atlas"]');
    }
  });

  it('counts only the property that was substituted, not every string property', () => {
    const result = validateExtractionOutput(
      { entities: JSON.stringify(validEntities), relationships: [] },
      sampleConfiguration,
    );
    expect(result.ok).toBe(true);
    expect(result.stringifiedArraysParsed).toBe(1);
  });

  it('still rejects entirely invalid content inside a successfully parsed array (Ajv stays the gate)', () => {
    const result = validateExtractionOutput(
      {
        entities: JSON.stringify([{ type: 'NotAType', properties: {} }]),
        relationships: [],
      },
      sampleConfiguration,
    );
    // The shim fixed the typing, but the CONTENT is still judged and rejected.
    expect(result.ok).toBe(false);
    expect(result.stringifiedArraysParsed).toBe(1);
  });
});

describe('validateExtractionOutput — failure modes', () => {
  const collectMessages = (out: unknown): string[] => {
    const result = validateExtractionOutput(out, sampleConfiguration);
    if (result.ok) throw new Error('expected validation failure');
    return result.errors.map((e) => `${e.path}: ${e.message}`);
  };

  it('rejects null input', () => {
    const result = validateExtractionOutput(null, sampleConfiguration);
    expect(result.ok).toBe(false);
  });

  it('rejects missing entities array', () => {
    const msgs = collectMessages({ relationships: [] });
    expect(msgs.some((m) => m.includes('entities'))).toBe(true);
  });

  it('rejects entity with unknown type', () => {
    const msgs = collectMessages({
      entities: [{ type: 'Pupil', properties: { name: 'x' } }],
      relationships: [],
    });
    expect(msgs.some((m) => m.includes('not a configured entity type'))).toBe(true);
  });

  it('rejects entity missing required property', () => {
    const msgs = collectMessages({
      entities: [{ type: 'Project', properties: {} }],
      relationships: [],
    });
    expect(msgs.some((m) => m.includes('properties'))).toBe(true);
  });

  it('rejects relationship index out of bounds', () => {
    const msgs = collectMessages({
      entities: [{ type: 'Project', properties: { name: 'A' } }],
      relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 5 }],
    });
    expect(msgs.some((m) => m.includes('out of bounds'))).toBe(true);
  });

  it('rejects relationship with incompatible from/to types', () => {
    const msgs = collectMessages({
      entities: [
        { type: 'Project', properties: { name: 'A' } },
        { type: 'Task', properties: { title: 't' } },
      ],
      // managedBy is Project->Person; Project->Task is invalid.
      relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
    });
    expect(msgs.some((m) => m.includes("'Task'"))).toBe(true);
  });

  it('rejects self-loop relationships', () => {
    const msgs = collectMessages({
      entities: [{ type: 'Person', properties: { fullName: 'Alone' } }],
      relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 0 }],
    });
    expect(msgs.some((m) => m.includes('self-loop'))).toBe(true);
  });

  it('rejects unknown relationship type', () => {
    const msgs = collectMessages({
      entities: [
        { type: 'Project', properties: { name: 'A' } },
        { type: 'Person', properties: { fullName: 'B' } },
      ],
      relationships: [{ type: 'nonsenseRelation', fromIndex: 0, toIndex: 1 }],
    });
    expect(msgs.some((m) => m.includes('not a configured relationship type'))).toBe(true);
  });

  it('aggregates multiple errors in one pass', () => {
    const msgs = collectMessages({
      entities: [
        { type: 'Pupil', properties: {} },
        { type: 'Project', properties: {} },
      ],
      relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
    });
    // At least: unknown entity type + missing required + relationship type mismatch
    expect(msgs.length).toBeGreaterThan(1);
  });
});

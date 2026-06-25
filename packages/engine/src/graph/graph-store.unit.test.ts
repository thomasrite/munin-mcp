// Unit tests for GraphStore types and pure helpers.
// No DB; fast. The permission and behaviour matrix lives in the
// .int.test.ts file.

import { describe, expect, it } from 'vitest';

import { InvalidProvenanceError, NotFoundError } from './errors';
import { toPgTextArrayLiteral } from './postgres-graph-store';
import { provenanceFromRow, provenanceToColumns } from './postgres-mapping';
import {
  asDocumentId,
  asExtractorVersionId,
  asParagraphId,
  internalBypass,
  newEntityId,
} from './types';

describe('internalBypass()', () => {
  it('constructs a token with the given callSite and reason', () => {
    const token = internalBypass('test.call.site', 'forensic test');
    expect(token.callSite).toBe('test.call.site');
    expect(token.reason).toBe('forensic test');
  });

  it('rejects empty callSite', () => {
    expect(() => internalBypass('', 'reason')).toThrow(/non-empty callSite/);
    expect(() => internalBypass('   ', 'reason')).toThrow(/non-empty callSite/);
  });

  it('rejects empty reason', () => {
    expect(() => internalBypass('site', '')).toThrow(/non-empty reason/);
    expect(() => internalBypass('site', '   ')).toThrow(/non-empty reason/);
  });

  it('tokens carry a non-enumerable brand symbol that fabricated objects lack', () => {
    const real = internalBypass('x', 'y');
    const realSymbols = Object.getOwnPropertySymbols(real);
    expect(realSymbols.length).toBeGreaterThanOrEqual(1);

    const fabricated = { callSite: 'x', reason: 'y' } as Record<string, unknown>;
    expect(Object.getOwnPropertySymbols(fabricated).length).toBe(0);
  });
});

describe('id factories', () => {
  it('newEntityId returns a UUIDv4 string', () => {
    const id = newEntityId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('provenance discriminated union round-trip', () => {
  const docId = asDocumentId('00000000-0000-0000-0000-000000000001');
  const paraId = asParagraphId('00000000-0000-0000-0000-000000000002');
  const extId = asExtractorVersionId('00000000-0000-0000-0000-000000000003');

  it('document_extract → columns → provenance', () => {
    const original = {
      kind: 'document_extract' as const,
      documentId: docId,
      paragraphId: paraId,
      extractorVersionId: extId,
      confidence: 0.92,
    };
    const cols = provenanceToColumns(original);
    expect(cols.source_kind).toBe('document_extract');
    expect(cols.source_paragraph_id).toBe(paraId);
    expect(cols.extractor_version_id).toBe(extId);
    expect(cols.confidence).toBe(0.92);
    const round = provenanceFromRow(cols);
    expect(round).toEqual(original);
  });

  it('connector → columns → provenance', () => {
    const original = {
      kind: 'connector' as const,
      connectorPackage: '@muninhq/connector-test',
      documentId: null,
      confidence: null,
    };
    const cols = provenanceToColumns(original);
    expect(cols.source_kind).toBe('connector');
    expect(cols.source_connector_package).toBe('@muninhq/connector-test');
    expect(cols.source_paragraph_id).toBeNull();
    expect(cols.extractor_version_id).toBeNull();
    const round = provenanceFromRow(cols);
    expect(round).toEqual(original);
  });

  it('manual → columns → provenance', () => {
    const original = { kind: 'manual' as const, confidence: 0.5 };
    const cols = provenanceToColumns(original);
    expect(cols.source_kind).toBe('manual');
    const round = provenanceFromRow(cols);
    expect(round).toEqual(original);
  });

  it('system → columns → provenance', () => {
    const original = { kind: 'system' as const };
    const cols = provenanceToColumns(original);
    expect(cols.source_kind).toBe('system');
    expect(cols.confidence).toBeNull();
    const round = provenanceFromRow(cols);
    expect(round).toEqual(original);
  });
});

describe('toPgTextArrayLiteral', () => {
  it('empty array → {}', () => {
    expect(toPgTextArrayLiteral([])).toBe('{}');
  });

  it('simple unquoted values', () => {
    expect(toPgTextArrayLiteral(['a', 'b', 'c'])).toBe('{a,b,c}');
  });

  it('values with colons and slashes pass through unquoted', () => {
    expect(toPgTextArrayLiteral(['t:public', 'org:abc:dept:s1'])).toBe(
      '{t:public,org:abc:dept:s1}',
    );
  });

  it('values with whitespace or commas are quoted', () => {
    expect(toPgTextArrayLiteral(['has space', 'with,comma'])).toBe('{"has space","with,comma"}');
  });

  it('values containing double quotes or backslashes are escaped', () => {
    expect(toPgTextArrayLiteral(['a"b', 'a\\b'])).toBe('{"a\\"b","a\\\\b"}');
  });

  it("the literal string 'NULL' is quoted (case-insensitive)", () => {
    expect(toPgTextArrayLiteral(['null', 'NULL', 'Null'])).toBe('{"null","NULL","Null"}');
  });
});

describe('error subclasses', () => {
  it('NotFoundError carries kind and id', () => {
    const err = new NotFoundError('entity', 'abc');
    expect(err.kind).toBe('entity');
    expect(err.id).toBe('abc');
    expect(err.message).toContain('entity');
    expect(err.message).toContain('abc');
  });

  it('InvalidProvenanceError prefixes the message', () => {
    const err = new InvalidProvenanceError('foo');
    expect(err.message).toMatch(/^invalid provenance: foo$/);
  });
});

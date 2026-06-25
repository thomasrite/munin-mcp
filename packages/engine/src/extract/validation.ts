// Composite validator for the extractor's tool-call output.
//
// Anthropic enforces shape at decode time when the tool's input_schema is
// supplied. We re-validate ourselves as defence-in-depth, partly because
// the constraint is not 100% perfect and partly so future free-form
// providers go through the same pathway with the same diagnostics.
//
// Validation layers:
//   1. Top-level shape — { entities: array, relationships: array }
//   2. Entity type membership — each entity.type is a configured name
//   3. Entity property schemas — Ajv against the entity-type schema
//   4. Relationship type membership
//   5. Relationship index bounds and from/to type compatibility
//   6. No self-loops (matches the edges_no_self_loop CHECK in 1.2)
//
// On any failure we collect every error before returning so the repair
// prompt can address all of them in one go.

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import type {
  Configuration,
  EntityTypeDefinition,
  ExpectedEntity,
  ExpectedRelationship,
  ExtractionExpectation,
  JsonObjectSchema,
  RelationshipTypeDefinition,
} from '@muninhq/shared';

import { assembleExtractionPrompt } from './prompt-assembly';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Cache compiled validators by (entity-type-name, schemaHash) so we don't
// pay the ~100ms compilation cost on every paragraph. Keyed on the inline
// JSON-stringified schema for simplicity.
const compilationCache = new Map<string, ValidateFunction>();

function compileForSchema(schema: JsonObjectSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = compilationCache.get(key);
  if (cached) return cached;
  const validator = ajv.compile(schema);
  compilationCache.set(key, validator);
  return validator;
}

// ---------------------------------------------------------------------------
// F63 — stringified-array tolerance (parse-or-leave; Ajv remains the gate)
//
// Small local models (measured: llama3.1:8b, llama3.2:3b via Ollama) extract
// the right entities but emit top-level array tool arguments as JSON-encoded
// STRINGS. Before validation we apply one narrow normalisation: for each
// TOP-LEVEL property of the extraction tool schema whose declared type is
// 'array', a string value is JSON.parsed once; if the result is an array it is
// substituted, in every other case (parse failure, parses to non-array, value
// not a string, schema type not array) the value is left byte-untouched for
// the validators below to judge. Schema-driven, never key-name-driven; no
// other coercion; the input object is never mutated (the repair prompt must
// see the model's original output).
// ---------------------------------------------------------------------------

// Top-level array-typed property names of the extraction tool schema, derived
// from the same builder the LLM call uses. Memoised per Configuration object.
const arrayPropsCache = new WeakMap<Configuration, ReadonlySet<string>>();

function topLevelArrayProperties(config: Configuration): ReadonlySet<string> {
  const cached = arrayPropsCache.get(config);
  if (cached) return cached;
  const inputSchema = assembleExtractionPrompt(config).tool.inputSchema;
  const properties = inputSchema.properties;
  const names = new Set<string>();
  if (properties !== null && typeof properties === 'object') {
    for (const [name, prop] of Object.entries(properties as Record<string, unknown>)) {
      if (
        prop !== null &&
        typeof prop === 'object' &&
        (prop as Record<string, unknown>).type === 'array'
      ) {
        names.add(name);
      }
    }
  }
  arrayPropsCache.set(config, names);
  return names;
}

function normaliseStringifiedArrays(
  rawInput: unknown,
  config: Configuration,
): { readonly value: unknown; readonly parsed: number } {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { value: rawInput, parsed: 0 };
  }
  const obj = rawInput as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  let parsed = 0;
  for (const key of topLevelArrayProperties(config)) {
    const value = obj[key];
    if (typeof value !== 'string') continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(value);
    } catch {
      continue; // malformed JSON — leave the string for the validators to reject
    }
    if (!Array.isArray(candidate)) continue; // parses, but not to an array — leave it
    out ??= { ...obj };
    out[key] = candidate;
    parsed++;
  }
  return { value: out ?? rawInput, parsed };
}

export interface ValidationOk {
  readonly ok: true;
  readonly value: ExtractionExpectation;
  // F63: how many top-level stringified arrays were parse-substituted before
  // validation. 0 on well-typed output.
  readonly stringifiedArraysParsed: number;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly ValidationError[];
  readonly stringifiedArraysParsed: number;
}

export type ValidationResult = ValidationOk | ValidationFail;

export function validateExtractionOutput(
  rawInput: unknown,
  config: Configuration,
): ValidationResult {
  const errors: ValidationError[] = [];

  // F63 shim — normalise stringified top-level arrays BEFORE validation.
  const { value: input, parsed: stringifiedArraysParsed } = normaliseStringifiedArrays(
    rawInput,
    config,
  );

  // 1. Top-level shape
  if (input === null || typeof input !== 'object') {
    return {
      ok: false,
      errors: [{ path: '$', message: 'output is not an object' }],
      stringifiedArraysParsed,
    };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.entities)) {
    errors.push({ path: '$.entities', message: 'must be an array' });
  }
  if (!Array.isArray(obj.relationships)) {
    errors.push({ path: '$.relationships', message: 'must be an array' });
  }
  if (errors.length > 0) return { ok: false, errors, stringifiedArraysParsed };

  const entitiesRaw = obj.entities as unknown[];
  const relationshipsRaw = obj.relationships as unknown[];
  const entitiesByName = new Map(config.entityTypes.map((e) => [e.name, e]));
  const relsByName = new Map(config.relationshipTypes.map((r) => [r.name, r]));

  // 2 & 3. Validate each entity
  const entitiesOut: ExpectedEntity[] = [];
  entitiesRaw.forEach((raw, i) => {
    const entityResult = validateEntity(raw, i, entitiesByName);
    if (!entityResult.ok) {
      errors.push(...entityResult.errors);
    } else {
      entitiesOut.push(entityResult.value);
    }
  });

  // 4, 5, 6. Validate each relationship
  const relationshipsOut: ExpectedRelationship[] = [];
  relationshipsRaw.forEach((raw, i) => {
    const relResult = validateRelationship(raw, i, relsByName, entitiesOut);
    if (!relResult.ok) {
      errors.push(...relResult.errors);
    } else {
      relationshipsOut.push(relResult.value);
    }
  });

  if (errors.length > 0) return { ok: false, errors, stringifiedArraysParsed };

  return {
    ok: true,
    value: {
      entities: entitiesOut,
      relationships: relationshipsOut,
    },
    stringifiedArraysParsed,
  };
}

interface EntityValidationOk {
  readonly ok: true;
  readonly value: ExpectedEntity;
}
interface EntityValidationFail {
  readonly ok: false;
  readonly errors: readonly ValidationError[];
}

function validateEntity(
  raw: unknown,
  index: number,
  entitiesByName: ReadonlyMap<string, EntityTypeDefinition>,
): EntityValidationOk | EntityValidationFail {
  const path = `$.entities[${index}]`;
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: [{ path, message: 'must be an object' }] };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    return { ok: false, errors: [{ path: `${path}.type`, message: 'must be a string' }] };
  }
  const defn = entitiesByName.get(obj.type);
  if (!defn) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.type`,
          message: `'${obj.type}' is not a configured entity type (valid: ${Array.from(entitiesByName.keys()).join(', ')})`,
        },
      ],
    };
  }
  if (obj.properties === null || typeof obj.properties !== 'object') {
    return { ok: false, errors: [{ path: `${path}.properties`, message: 'must be an object' }] };
  }

  const validator = compileForSchema(defn.propertySchema);
  if (!validator(obj.properties)) {
    const ajvErrors = (validator.errors ?? []).map((e) => ({
      path: `${path}.properties${e.instancePath ?? ''}`,
      message: e.message ?? 'validation failed',
    }));
    return { ok: false, errors: ajvErrors };
  }

  return {
    ok: true,
    value: {
      type: defn.name,
      properties: obj.properties as Readonly<Record<string, unknown>>,
      ...(Array.isArray(obj.mentionSpan) && obj.mentionSpan.length === 2
        ? { mentionSpan: [Number(obj.mentionSpan[0]), Number(obj.mentionSpan[1])] as const }
        : {}),
    },
  };
}

interface RelValidationOk {
  readonly ok: true;
  readonly value: ExpectedRelationship;
}
interface RelValidationFail {
  readonly ok: false;
  readonly errors: readonly ValidationError[];
}

function validateRelationship(
  raw: unknown,
  index: number,
  relsByName: ReadonlyMap<string, RelationshipTypeDefinition>,
  entities: readonly ExpectedEntity[],
): RelValidationOk | RelValidationFail {
  const path = `$.relationships[${index}]`;
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: [{ path, message: 'must be an object' }] };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    return { ok: false, errors: [{ path: `${path}.type`, message: 'must be a string' }] };
  }
  const defn = relsByName.get(obj.type);
  if (!defn) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.type`,
          message: `'${obj.type}' is not a configured relationship type`,
        },
      ],
    };
  }
  if (typeof obj.fromIndex !== 'number' || !Number.isInteger(obj.fromIndex)) {
    return { ok: false, errors: [{ path: `${path}.fromIndex`, message: 'must be an integer' }] };
  }
  if (typeof obj.toIndex !== 'number' || !Number.isInteger(obj.toIndex)) {
    return { ok: false, errors: [{ path: `${path}.toIndex`, message: 'must be an integer' }] };
  }
  if (obj.fromIndex < 0 || obj.fromIndex >= entities.length) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.fromIndex`,
          message: `out of bounds: ${obj.fromIndex} (entities has ${entities.length})`,
        },
      ],
    };
  }
  if (obj.toIndex < 0 || obj.toIndex >= entities.length) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.toIndex`,
          message: `out of bounds: ${obj.toIndex} (entities has ${entities.length})`,
        },
      ],
    };
  }
  if (obj.fromIndex === obj.toIndex) {
    return { ok: false, errors: [{ path, message: 'self-loop edges are not permitted' }] };
  }
  const fromEntity = entities[obj.fromIndex];
  const toEntity = entities[obj.toIndex];
  if (fromEntity === undefined || toEntity === undefined) {
    return {
      ok: false,
      errors: [{ path, message: 'relationship references a non-existent entity index' }],
    };
  }
  const fromType = fromEntity.type;
  const toType = toEntity.type;
  if (!defn.fromTypes.includes(fromType)) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.fromIndex`,
          message: `entity ${obj.fromIndex} has type '${fromType}', not one of ${defn.fromTypes.join(' | ')}`,
        },
      ],
    };
  }
  if (!defn.toTypes.includes(toType)) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.toIndex`,
          message: `entity ${obj.toIndex} has type '${toType}', not one of ${defn.toTypes.join(' | ')}`,
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      type: defn.name,
      fromIndex: obj.fromIndex,
      toIndex: obj.toIndex,
      ...(obj.properties !== undefined && obj.properties !== null
        ? { properties: obj.properties as Readonly<Record<string, unknown>> }
        : {}),
    },
  };
}

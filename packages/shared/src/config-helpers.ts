// Authoring helpers for configuration files.
//
// These helpers produce JSON-Schema fragments and configuration nodes with
// minimal ceremony. They do not perform deep validation — that lives in
// `config-compose.ts`. The goal here is a pleasant authoring experience
// for the engineer writing a configuration package.

import type {
  ConnectorBinding,
  EntityResolutionHints,
  EntityTypeDefinition,
  ExpansionPlan,
  FewShotExample,
  JsonArraySchema,
  JsonBooleanSchema,
  JsonNumberSchema,
  JsonObjectSchema,
  JsonSchema,
  JsonStringSchema,
  QueryTemplate,
  RelationshipTypeDefinition,
  RoleDefinition,
  SlotDefinition,
} from './config-schema';

// ---------------------------------------------------------------------------
// Primitive JSON Schema helpers
// ---------------------------------------------------------------------------

export function str(
  opts: {
    description?: string;
    format?: JsonStringSchema['format'];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enum?: readonly string[];
  } = {},
): JsonStringSchema {
  return { type: 'string', ...stripUndefined(opts) };
}

export function num(
  opts: {
    description?: string;
    integer?: boolean;
    minimum?: number;
    maximum?: number;
  } = {},
): JsonNumberSchema {
  return { type: 'number', ...stripUndefined(opts) };
}

export function bool(opts: { description?: string } = {}): JsonBooleanSchema {
  return { type: 'boolean', ...stripUndefined(opts) };
}

export function date(opts: { description?: string } = {}): JsonStringSchema {
  return { type: 'string', format: 'date', ...stripUndefined(opts) };
}

export function dateTime(opts: { description?: string } = {}): JsonStringSchema {
  return { type: 'string', format: 'date-time', ...stripUndefined(opts) };
}

export function arr(
  items: JsonSchema,
  opts: { description?: string; minItems?: number; maxItems?: number } = {},
): JsonArraySchema {
  return { type: 'array', items, ...stripUndefined(opts) };
}

export function obj(
  properties: Readonly<Record<string, JsonSchema>>,
  opts: {
    required?: readonly string[];
    description?: string;
    additionalProperties?: boolean;
  } = {},
): JsonObjectSchema {
  return {
    type: 'object',
    properties,
    required: opts.required ?? [],
    ...stripUndefined({
      description: opts.description,
      additionalProperties: opts.additionalProperties,
    }),
  };
}

// ---------------------------------------------------------------------------
// Configuration node helpers
// ---------------------------------------------------------------------------

export function entityType(opts: {
  name: string;
  description: string;
  properties: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  fewShots: readonly FewShotExample[];
  resolution?: EntityResolutionHints;
}): EntityTypeDefinition {
  return {
    name: opts.name,
    description: opts.description,
    propertySchema: obj(opts.properties, {
      description: opts.description,
      ...(opts.required !== undefined ? { required: opts.required } : {}),
    }),
    fewShots: opts.fewShots,
    ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
  };
}

export function relationshipType(opts: {
  name: string;
  description: string;
  fromTypes: readonly string[];
  toTypes: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  fewShots?: readonly FewShotExample[];
}): RelationshipTypeDefinition {
  const result: {
    -readonly [K in keyof RelationshipTypeDefinition]: RelationshipTypeDefinition[K];
  } = {
    name: opts.name,
    description: opts.description,
    fromTypes: opts.fromTypes,
    toTypes: opts.toTypes,
  };
  if (opts.properties) {
    result.propertySchema = obj(
      opts.properties,
      opts.required !== undefined ? { required: opts.required } : {},
    );
  }
  if (opts.fewShots) {
    result.fewShots = opts.fewShots;
  }
  return result;
}

export function role(opts: {
  name: string;
  description: string;
  baseTags: readonly string[];
  capabilities?: readonly string[];
}): RoleDefinition {
  return opts;
}

export function slot(opts: SlotDefinition): SlotDefinition {
  return opts;
}

export function queryTemplate(opts: {
  id: string;
  title: string;
  description: string;
  slots: Readonly<Record<string, SlotDefinition>>;
  expansion: ExpansionPlan;
}): QueryTemplate {
  return opts;
}

export function connectorBinding(opts: {
  packageName: string;
  description: string;
  perTenantConfigSchema: JsonObjectSchema;
}): ConnectorBinding {
  return opts;
}

// ---------------------------------------------------------------------------
// Internal: strip undefined fields so we don't pollute hashed JSON.
// ---------------------------------------------------------------------------

function stripUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

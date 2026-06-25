// Builds the deterministic prompt + tool definition for the extractor.
//
// Determinism matters because the assembled prompt is the input to
// `promptHash`, which combines with `schemaHash` to form the prompt-cache
// key. If we serialise differently across calls, the cache misses and we
// pay full-price tokens for what should have been free reads. Specifically:
//   - Entity types are emitted in the configuration's declaration order.
//   - Relationship types likewise.
//   - Few-shots within each entity type are emitted in declaration order.
//   - JSON Schema property keys preserve insertion order (V8/Node default).
//
// The tool definition is the single source of structural constraint
// (Anthropic enforces shape at decode time). The system prompt is for
// semantic guidance: what the entity types mean, the few-shots, the rules
// about omitting confidence.

import type {
  Configuration,
  EntityTypeDefinition,
  FewShotExample,
  JsonObjectSchema,
  JsonSchema,
  RelationshipTypeDefinition,
} from '@muninhq/shared';

import type { LLMTool } from '../providers';

// Bumped whenever the wrapper text changes. Folded into promptHash so the
// extraction cache invalidates cleanly when we tune wording.
export const SYSTEM_PROMPT_VERSION = '1' as const;

export const EXTRACTION_TOOL_NAME = 'extract_entities_and_relationships';

export interface AssembledPrompt {
  readonly system: string;
  readonly tool: LLMTool;
  readonly toolName: string;
}

export function assembleExtractionPrompt(config: Configuration): AssembledPrompt {
  return {
    system: buildSystemPrompt(config),
    tool: buildExtractionTool(config),
    toolName: EXTRACTION_TOOL_NAME,
  };
}

// ---------------------------------------------------------------------------
// System prompt — semantic guidance + few-shots
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: Configuration): string {
  const lines: string[] = [];
  lines.push(
    `You are a structured-extraction system. Given a paragraph of text, call the \`${EXTRACTION_TOOL_NAME}\` tool with the entities and relationships you can identify. If the paragraph contains no extractable entities, call the tool with empty arrays.`,
  );
  lines.push('');
  lines.push(`Configuration: ${config.id} v${config.version}`);
  lines.push('');
  lines.push('## Entity types');
  for (const entity of config.entityTypes) {
    lines.push('');
    lines.push(`### ${entity.name}`);
    lines.push(entity.description);
    lines.push('');
    lines.push('Property schema (JSON Schema):');
    lines.push('```json');
    lines.push(JSON.stringify(entity.propertySchema, null, 2));
    lines.push('```');
  }
  lines.push('');
  lines.push('## Relationship types');
  for (const rel of config.relationshipTypes) {
    lines.push('');
    lines.push(`### ${rel.name}`);
    lines.push(rel.description);
    lines.push(`From: ${rel.fromTypes.join(' | ')}`);
    lines.push(`To: ${rel.toTypes.join(' | ')}`);
  }
  lines.push('');
  lines.push('## Few-shot examples');
  for (const entity of config.entityTypes) {
    for (const example of entity.fewShots) {
      lines.push('');
      lines.push(renderFewShot(example));
    }
  }
  lines.push('');
  lines.push('## Rules');
  lines.push(
    '- Use only the entity types and relationship types defined above. ' +
      'Inventing new types is a failure.',
  );
  lines.push(
    '- relationships[].fromIndex and relationships[].toIndex are 0-based ' +
      'indexes into the entities array you produce in the same call.',
  );
  lines.push(
    '- Do NOT invent a confidence score. The engine derives confidence ' +
      'from whether values appear verbatim in the source text; it is not ' +
      'your responsibility.',
  );
  lines.push(
    '- If a paragraph mentions an entity but does not contain enough ' +
      'information to fill a required property, omit the entity entirely.',
  );
  lines.push(
    '- Each call to the extraction tool is independent. Do not assume the ' +
      'existence of entities mentioned in earlier paragraphs.',
  );
  lines.push(`- System prompt version: ${SYSTEM_PROMPT_VERSION}.`);
  return lines.join('\n');
}

function renderFewShot(example: FewShotExample): string {
  const lines: string[] = [];
  lines.push('Input:');
  lines.push(JSON.stringify(example.input));
  lines.push('Tool call:');
  lines.push(JSON.stringify(example.output, null, 2));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition — Anthropic enforces shape at decode time
// ---------------------------------------------------------------------------

function buildExtractionTool(config: Configuration): LLMTool {
  return {
    name: EXTRACTION_TOOL_NAME,
    description:
      'Record entities and relationships extracted from a single paragraph. ' +
      'Always call this tool, even when the paragraph yields no entities ' +
      '(in which case pass empty arrays).',
    inputSchema: buildToolInputSchema(config),
  };
}

function buildToolInputSchema(config: Configuration): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        description: 'Entities extracted from the paragraph.',
        items: {
          oneOf: config.entityTypes.map((e) => entityVariant(e)),
        },
      },
      relationships: {
        type: 'array',
        description: 'Directed relationships between extracted entities.',
        items: {
          oneOf: config.relationshipTypes.map((r) => relationshipVariant(r)),
        },
      },
    },
    required: ['entities', 'relationships'],
    additionalProperties: false,
  };
}

function entityVariant(entity: EntityTypeDefinition): Record<string, unknown> {
  return {
    type: 'object',
    description: entity.description,
    properties: {
      type: { type: 'string', const: entity.name },
      properties: stripCustomFields(entity.propertySchema),
      mentionSpan: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        minItems: 2,
        maxItems: 2,
        description:
          'Optional [start, end) character span in the paragraph where the entity is mentioned. Omit if uncertain.',
      },
    },
    required: ['type', 'properties'],
    additionalProperties: false,
  };
}

function relationshipVariant(rel: RelationshipTypeDefinition): Record<string, unknown> {
  const propSchema = rel.propertySchema ?? { type: 'object', properties: {}, required: [] };
  return {
    type: 'object',
    description: rel.description,
    properties: {
      type: { type: 'string', const: rel.name },
      fromIndex: {
        type: 'integer',
        minimum: 0,
        description: `Index into entities[] for a ${rel.fromTypes.join(' | ')} entity.`,
      },
      toIndex: {
        type: 'integer',
        minimum: 0,
        description: `Index into entities[] for a ${rel.toTypes.join(' | ')} entity.`,
      },
      properties: stripCustomFields(propSchema),
    },
    required: ['type', 'fromIndex', 'toIndex'],
    additionalProperties: false,
  };
}

// JSON Schema doesn't permit non-standard fields where strictness is on.
// Our entity-property schemas are already standard JSON Schema, but if a
// configuration adds extra keys we strip them here.
function stripCustomFields(schema: JsonObjectSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'object',
    properties: cleanProperties(schema.properties),
    required: schema.required ?? [],
    additionalProperties: false,
  };
  if (schema.description !== undefined) out.description = schema.description;
  return out;
}

function cleanProperties(
  properties: Readonly<Record<string, JsonSchema>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

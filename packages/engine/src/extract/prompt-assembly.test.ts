import { describe, expect, it } from 'vitest';

import { sampleConfiguration } from '../test-support/sample-configuration';

import { computeSchemaHash } from '@muninhq/shared';
import {
  EXTRACTION_TOOL_NAME,
  SYSTEM_PROMPT_VERSION,
  assembleExtractionPrompt,
} from './prompt-assembly';
import { computePromptHash } from './prompt-hashing';

describe('assembleExtractionPrompt', () => {
  it('produces a system prompt mentioning every configured entity and relationship', () => {
    const { system } = assembleExtractionPrompt(sampleConfiguration);
    for (const entity of sampleConfiguration.entityTypes) {
      expect(system).toContain(`### ${entity.name}`);
    }
    for (const rel of sampleConfiguration.relationshipTypes) {
      expect(system).toContain(`### ${rel.name}`);
    }
  });

  it('emits exactly the configured tool name', () => {
    const { tool, toolName } = assembleExtractionPrompt(sampleConfiguration);
    expect(toolName).toBe(EXTRACTION_TOOL_NAME);
    expect(tool.name).toBe(EXTRACTION_TOOL_NAME);
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('tool input_schema enumerates one variant per entity type via oneOf', () => {
    const { tool } = assembleExtractionPrompt(sampleConfiguration);
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    const entities = props.entities as Record<string, unknown>;
    const items = entities.items as Record<string, unknown>;
    const oneOf = items.oneOf as unknown[];
    expect(oneOf.length).toBe(sampleConfiguration.entityTypes.length);
  });

  it('two assemblies of the same configuration produce identical output', () => {
    const a = assembleExtractionPrompt(sampleConfiguration);
    const b = assembleExtractionPrompt(sampleConfiguration);
    expect(JSON.stringify(a.tool)).toBe(JSON.stringify(b.tool));
    expect(a.system).toBe(b.system);
  });

  it('system prompt embeds the version marker', () => {
    const { system } = assembleExtractionPrompt(sampleConfiguration);
    expect(system).toContain(`System prompt version: ${SYSTEM_PROMPT_VERSION}`);
  });
});

describe('computePromptHash', () => {
  it('is deterministic', () => {
    const inputs = {
      configurationId: sampleConfiguration.id,
      configurationVersion: sampleConfiguration.version,
      schemaHash: computeSchemaHash(sampleConfiguration),
      modelId: 'test-model',
    };
    expect(computePromptHash(inputs)).toBe(computePromptHash(inputs));
  });

  it('changes when modelId changes', () => {
    const base = {
      configurationId: sampleConfiguration.id,
      configurationVersion: sampleConfiguration.version,
      schemaHash: computeSchemaHash(sampleConfiguration),
      modelId: 'model-a',
    };
    const a = computePromptHash(base);
    const b = computePromptHash({ ...base, modelId: 'model-b' });
    expect(a).not.toBe(b);
  });

  it('changes when schemaHash changes', () => {
    const base = {
      configurationId: 'cfg',
      configurationVersion: '1.0.0',
      schemaHash: 'h1',
      modelId: 'm',
    };
    expect(computePromptHash(base)).not.toBe(computePromptHash({ ...base, schemaHash: 'h2' }));
  });
});

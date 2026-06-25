// Computes promptHash, the second half of the extractor_versions natural key.
//
// `schemaHash` (from @muninhq/shared/config-compose) covers extraction-affecting
// configuration content. `promptHash` covers the wrapper text we add on top —
// system prompt template, rules, tool name. Bumping `SYSTEM_PROMPT_VERSION`
// in `prompt-assembly.ts` produces a new `promptHash` and so a new
// `extractor_versions` row.

import { createHash } from 'node:crypto';

import { EXTRACTION_TOOL_NAME, SYSTEM_PROMPT_VERSION } from './prompt-assembly';

export interface PromptHashInputs {
  readonly configurationId: string;
  readonly configurationVersion: string;
  readonly schemaHash: string;
  readonly modelId: string;
}

export function computePromptHash(inputs: PromptHashInputs): string {
  const payload = {
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    toolName: EXTRACTION_TOOL_NAME,
    configurationId: inputs.configurationId,
    configurationVersion: inputs.configurationVersion,
    schemaHash: inputs.schemaHash,
    modelId: inputs.modelId,
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

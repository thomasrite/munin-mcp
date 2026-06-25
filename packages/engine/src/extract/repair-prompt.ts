// Builds a single repair message after a validation failure.
//
// Used for the one allowed retry. After the repair attempt, if validation
// still fails, the paragraph is logged as failed and skipped — no further
// retries.

import type { ValidationError } from './validation';

const MAX_RAW_LENGTH = 4096;

export function buildRepairMessage(rawOutput: unknown, errors: readonly ValidationError[]): string {
  const lines: string[] = [];
  lines.push(
    'Your previous extraction tool call failed validation. Please correct ' +
      'the issues below and call the tool again.',
  );
  lines.push('');
  lines.push('Validation errors:');
  for (const e of errors.slice(0, 20)) {
    lines.push(`  - ${e.path}: ${e.message}`);
  }
  if (errors.length > 20) {
    lines.push(`  - ... ${errors.length - 20} additional errors omitted`);
  }
  lines.push('');
  lines.push('Your previous tool input was:');
  lines.push('```json');
  lines.push(truncate(JSON.stringify(rawOutput, null, 2)));
  lines.push('```');
  lines.push('');
  lines.push(
    'Return the corrected extraction by calling the tool again. Do not ' +
      'explain in text; just call the tool.',
  );
  return lines.join('\n');
}

function truncate(s: string): string {
  if (s.length <= MAX_RAW_LENGTH) return s;
  return `${s.slice(0, MAX_RAW_LENGTH)}\n... (${s.length - MAX_RAW_LENGTH} bytes truncated)`;
}

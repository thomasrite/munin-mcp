// A single sensitivity class: everything in a personal memory is private to
// its one owner. The class's access tag is 'personal' — the SAME tag the
// owner role grants and local:init's printed ingest command writes, so the
// CLI path, the web upload path, and the read path all converge on one tag.
//
// Minimal by design (mirrors the baseline's shape, not its two-class split):
// a one-user memory has no "wider" audience to widen access to. A future
// multi-class need is a cartridge change, not an engine one.

import type { SensitivityClass } from '@muninhq/shared';

export const sensitivityClasses: readonly SensitivityClass[] = [
  {
    id: 'private',
    name: 'Private',
    scope: 'Only you',
    restricted: true,
    isDefault: true,
    accessTags: ['personal'],
  },
];

// CONFIG-LOAD ASSERTION (security invariant, mirrors generic-baseline): a
// restricted class with NO access tags is the upload-tagging leak — the upload
// route would resolve an empty tag set and fall through to the uploader's full
// grant. Fail fast at load so this can never silently regress.
function assertSensitivityInvariants(classes: readonly SensitivityClass[]): void {
  for (const c of classes) {
    if (c.restricted && (c.accessTags?.length ?? 0) === 0) {
      throw new Error(
        `config-personal sensitivity: restricted class '${c.id}' ships no accessTags. A restricted class MUST declare a real access tag, or the upload route would stamp the uploader's full grant instead.`,
      );
    }
  }
}

assertSensitivityInvariants(sensitivityClasses);

// Write-time access tags for a picked sensitivity class (the upload path).
// Flat configuration — no org scope, so the class's bare tags are returned
// as-is; unknown/absent class returns [] so the upload route fails closed.
export function writeTagsForClass(
  config: { readonly sensitivityClasses?: readonly SensitivityClass[] },
  input: { readonly classId: string | null | undefined; readonly scopeTags: readonly string[] },
): string[] {
  if (!input.classId) return [];
  const klass = config.sensitivityClasses?.find((c) => c.id === input.classId);
  const tags = klass?.accessTags ?? [];
  return tags.length === 0 ? [] : [...new Set(tags)];
}

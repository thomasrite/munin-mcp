// The baseline two-class sensitivity set. Opaque ids; the access tags are the
// load-bearing strings the engine filters on (the labels are cosmetic). Default
// at ingest is the RESTRICTED class (default-deny): a freshly-uploaded document
// is admin-only until someone widens it to General. Generic — no vertical
// vocabulary; a richer cartridge ships its own classes.

import type { SensitivityClass } from '@muninhq/shared';

// The scope×capability fusion separator — the single source of truth shared by
// the WRITE side (writeTagsForClass below) and any future scoped read path, so
// the two can never drift. Day-one the baseline is flat (no org tree), so the
// flat write path emits bare capability tags and this is unused; it is here so a
// tenant that later adds org units fuses identically to the established
// scope×capability convention used elsewhere in the engine's tag model.
export const COMPOUND = '|';

export const sensitivityClasses: readonly SensitivityClass[] = [
  // Most-protective first (tie-break convention): a document matching both
  // resolves to the restricted badge.
  {
    id: 'restricted',
    name: 'Restricted',
    scope: 'Administrators only',
    restricted: true,
    isDefault: true,
    accessTags: ['class:restricted'],
  },
  {
    id: 'general',
    name: 'General',
    scope: 'Everyone in this workspace',
    restricted: false,
    widensAccess: true,
    accessTags: ['class:general'],
  },
];

// CONFIG-LOAD ASSERTION (security invariant): a `restricted`
// class that ships NO access tags is the upload-tagging leak — the upload route
// would resolve an empty tag set and fall through to the uploader's full grant,
// turning the most-restrictive choice into the most-permissive. Fail FAST at
// load so this can never silently regress.
function assertSensitivityInvariants(classes: readonly SensitivityClass[]): void {
  for (const c of classes) {
    if (c.restricted && (c.accessTags?.length ?? 0) === 0) {
      throw new Error(
        `generic-baseline sensitivity: restricted class '${c.id}' ships no accessTags. A restricted class MUST declare a real access tag, or the upload route would stamp the uploader's full grant instead.`,
      );
    }
  }
}

assertSensitivityInvariants(sensitivityClasses);

// Write-time access tags for a picked sensitivity class (the upload path). The
// `|` scope×capability fusion convention lives HERE (configuration), never in the
// engine or web (Rule 1).
//
//   • Flat path (no org scope) → the class's BARE capability tags (e.g.
//     ['class:restricted']) — byte-identical to the flat read path.
//   • Scoped path → the scope × capability cross-product — NEVER the bare
//     capability, which would bridge across scopes under array-OVERLAP.
//
// Generic over `config.sensitivityClasses`: returns [] for an unknown/absent
// class, so the upload route fails closed.
export function writeTagsForClass(
  config: { readonly sensitivityClasses?: readonly SensitivityClass[] },
  input: { readonly classId: string | null | undefined; readonly scopeTags: readonly string[] },
): string[] {
  if (!input.classId) return [];
  const klass = config.sensitivityClasses?.find((c) => c.id === input.classId);
  const capabilities = klass?.accessTags ?? [];
  if (capabilities.length === 0) return [];

  if (input.scopeTags.length === 0) return [...new Set(capabilities)];

  const out = new Set<string>();
  for (const s of input.scopeTags) {
    for (const c of capabilities) out.add(`${s}${COMPOUND}${c}`);
  }
  return [...out];
}

import type { TagExpander } from '@muninhq/shared';

// The baseline is FLAT (document-level access, no org tree), so tag expansion is
// the identity (deduped): a caller's capability tags pass through unchanged and
// the engine filters by array-overlap against the document's class tags. This is
// the simple, safe day-one default. A tenant that needs hierarchical / scoped
// (departmental) access picks a richer cartridge whose tagExpansion fuses scope ×
// capability — the engine knows nothing of hierarchy either way (Rule 1: it
// receives a flat string[] and intersects).
export const tagExpansion: TagExpander = (baseTags) => [...new Set(baseTags)];

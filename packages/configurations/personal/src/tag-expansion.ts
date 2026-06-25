import type { TagExpander } from '@muninhq/shared';

// Flat identity expansion (deduped), exactly like the generic baseline: one
// user, one tag, no hierarchy. The engine receives a flat string[] and
// intersects — it knows nothing of hierarchy either way (Rule 1).
export const tagExpansion: TagExpander = (baseTags) => [...new Set(baseTags)];

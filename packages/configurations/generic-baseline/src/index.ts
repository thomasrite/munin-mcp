import type { Configuration } from '@muninhq/shared';

import { entities } from './entities';
import { queryTemplates } from './queries';
import { relationships } from './relationships';
import { roles } from './roles';
import { sensitivityClasses, writeTagsForClass } from './sensitivity';
import { tagExpansion } from './tag-expansion';
import { terminology } from './terminology';

// @muninhq/config-generic-baseline — the NEUTRAL product default.
//
// A tenant that picks no cartridge at onboarding still works on day one: this
// configuration ships the five universal entity shapes (Person / Organisation /
// Document / Event / Topic), a tiny relationship set, two flat roles, and a
// two-class default-deny sensitivity model with the write-side tag composer the
// upload path needs. It names NO vertical concept — that is the whole point. A
// tenant that wants domain structure selects a richer cartridge (e.g. mat-hr),
// which composes on top of (or replaces) this baseline; cartridge selection is a
// CONFIG choice, never a permission one.
export const genericBaselineConfiguration: Configuration = {
  id: 'generic-baseline',
  version: '0.1.0',
  description:
    'The neutral product baseline: Person / Organisation / Document / Event / Topic, ' +
    'two flat roles, and a two-class default-deny sensitivity model. The day-one default ' +
    'for a tenant that has selected no cartridge.',
  entityTypes: entities,
  relationshipTypes: relationships,
  terminology,
  roles,
  tagExpansion,
  queryTemplates,
  // NO documentTemplates — INTENTIONAL. A DocumentTemplate is a vertical's precise
  // generation grammar (e.g. an HR "return-to-work letter"); the neutral baseline
  // names no such document. This is NOT a generation dead end: the chat surface's
  // FREE-FORM path (chat-brain Step 3) lets a user issue a document command
  // ("make a summary of these notes") and Munin drafts it, grounded by open
  // retrieval over the instruction, with NO preconfigured template. Configured
  // templates remain the right abstraction for verticals (mat-hr); they are an
  // ADD-ON for structured, repeatable documents, never a prerequisite for drafting.
  // Short/dense ordinary documents embed slightly outside the engine's strict
  // 0.6 cosine cutoff; 0.75 admits genuine matches without diluting precision
  // (the validated value, mirrors generic-demo — see its queryDefaults note).
  queryDefaults: { distanceThreshold: 0.75 },
  // The baseline ships no connector bindings — day-one ingestion is direct
  // upload, not connector-driven federation (a post-pilot concern).
  connectors: [],
  sensitivityClasses,
  // Write-side tag composer (the upload path reaches this via the loaded
  // Configuration, never a static import). Closes over THIS config's classes.
  composeWriteTags: (input) => writeTagsForClass({ sensitivityClasses }, input),
};

export default genericBaselineConfiguration;

// Exported for tests / direct callers; the upload route reaches it through the
// generic `Configuration.composeWriteTags` field above, never a static import.
export { writeTagsForClass } from './sensitivity';

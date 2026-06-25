import type { Configuration } from '@muninhq/shared';

import { documentTemplates } from './document-templates';
import { entities } from './entities';
import { queryTemplates } from './queries';
import { relationships } from './relationships';
import { roles } from './roles';
import { sensitivityClasses, writeTagsForClass } from './sensitivity';
import { tagExpansion } from './tag-expansion';
import { terminology } from './terminology';

// @muninhq/config-personal — the personal-knowledge configuration.
//
// The prosumer default (local:init → ingest → extract → MCP): four
// conservative entity types tuned for personal prose (meeting notes, journal
// entries, reading notes, project logs), three relationships, one all-access
// owner role whose 'personal' base tag matches the ingest tag local:init
// prints, and a single private sensitivity class. Extraction quality is
// validated by the eval in src/eval/ (findings: EVAL-FINDINGS.md).
//
// Markdown-tool quirks (wikilinks, frontmatter) are a FUTURE CONNECTOR's job,
// not this package's — see README.md "Connector seam".
export const personalConfiguration: Configuration = {
  id: 'personal',
  version: '0.1.0',
  description:
    'A personal knowledge memory: People, Projects, Topics, and Sources extracted from your ' +
    'own notes, owned and read by exactly one person.',
  entityTypes: entities,
  relationshipTypes: relationships,
  terminology,
  roles,
  tagExpansion,
  queryTemplates,
  // M2.2 generation programs — the "Person dossier" the app/MCP can offer over a
  // person's gathered notes (grounded auto sections + static + asked-of-user).
  documentTemplates,
  // Short, dense personal notes embed slightly outside the engine's strict 0.6
  // cosine cutoff — 0.75 admits genuine matches without diluting precision
  // (the validated value the generic baseline and generic-demo both ship).
  queryDefaults: { distanceThreshold: 0.75 },
  // Day-one ingestion is the CLI / drag-in path, not connector federation.
  connectors: [],
  sensitivityClasses,
  composeWriteTags: (input) => writeTagsForClass({ sensitivityClasses }, input),
};

export default personalConfiguration;

// Exported for tests; the upload route reaches it through the generic
// `Configuration.composeWriteTags` field above, never a static import.
export { writeTagsForClass } from './sensitivity';
// Exported for the e2e generation eval; production reaches templates through the
// loaded `Configuration.documentTemplates` field above, never a static import.
export { documentTemplates, personDossier } from './document-templates';

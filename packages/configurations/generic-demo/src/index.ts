import type { Configuration } from '@muninhq/shared';

import { connectors } from './connectors';
import { documentTemplates } from './document-templates';
import { entities } from './entities';
import { queryTemplates } from './queries';
import { relationships } from './relationships';
import { roles } from './roles';
import { tagExpansion } from './tag-expansion';
import { terminology } from './terminology';

export const genericDemoConfiguration: Configuration = {
  id: 'generic-demo',
  version: '0.1.0',
  description:
    'A Projects / Tasks / People configuration used as the Phase 1 acceptance dataset. ' +
    'Exercises every feature of the configuration schema.',
  entityTypes: entities,
  relationshipTypes: relationships,
  terminology,
  roles,
  tagExpansion,
  queryTemplates,
  // Retrieval tuning (F-L1). The engine's default cosine cutoff (0.6) is too
  // strict for short / dense documents: a single-paragraph PDF or note embeds
  // far enough from a natural-language question that it falls outside 0.6 and
  // the query returns a false no_evidence, even though the document is ingested
  // and relevant. 0.75 is the validated value — it admits those genuine matches
  // (verified: a short uploaded PDF that no_evidence'd at 0.6 retrieves + cites
  // at 0.75). Tradeoff: a looser cutoff also lets weaker matches through, so
  // don't push it further without re-measuring — too loose pulls irrelevant
  // chunks into the grounding set and dilutes precision. Caller-level only; no
  // engine change. This config backs the web sandbox's `personal` pack, where
  // users upload their own short docs.
  queryDefaults: { distanceThreshold: 0.75 },
  connectors,
  documentTemplates,
};

// Phase 1 acceptance-gate ground truth + corpus location (session 1.8).
export { demoGroundTruth, demoDocsDir, demoIngestGroups } from './demo-eval/ground-truth';

// munin_gather_entity — "everything about X", routed through the engine's
// identity path (ContextRetriever.retrieveContext with the configuration's
// identity layer — the seam engine-api.md blesses for resolve → disambiguate →
// gather). A same-name collision returns the candidate list with pick tokens;
// the client re-calls with `pick`. A gathered set carries the honest
// mayHaveUnlinkedRecords completeness banner.

import { buildIdentity } from '../identity';
import { subjectNouns } from '../terminology';
import { SOURCES_CITATION_GUIDANCE } from './citation-guidance';
import {
  type ShapedDisambiguation,
  type ShapedSource,
  completenessBanner,
  shapeDisambiguation,
  shapeSource,
} from './shaping';
import type { ToolDeps } from './types';

export interface GatherEntityInput {
  readonly subject: string;
  readonly pick?: string;
}

export interface GatheredEntity {
  readonly status: 'gathered';
  readonly subject: string;
  readonly recordCount: number;
  readonly sources: readonly ShapedSource[];
  /** Honest completeness note; null when the gather is believed complete. */
  readonly completenessNote: string | null;
  /** Stable instruction: answer only from these sources and cite each one's citeAs token inline. */
  readonly citationGuidance: string;
}

export interface SubjectNotResolved {
  readonly status: 'not_resolved';
  readonly subject: string;
  readonly message: string;
}

export type GatherEntityResult = GatheredEntity | SubjectNotResolved | ShapedDisambiguation;

export async function gatherEntity(
  deps: ToolDeps,
  input: GatherEntityInput,
): Promise<GatherEntityResult> {
  const result = await deps.retriever.retrieveContext(deps.context, {
    // The subject IS the question on this path: classification routes on the
    // name-mention, then the identity path resolves + gathers by identity.
    question: input.subject,
    identity: buildIdentity(deps.configuration, input.pick),
  });

  if (result.kind === 'disambiguation') {
    return shapeDisambiguation(
      result.subject,
      result.group,
      result.pickWasStale,
      'munin_gather_entity',
    );
  }

  // The identity path did not resolve the subject (no visible match of the
  // configured subject types) — say so rather than passing open-path results
  // off as a gather.
  if (result.method !== 'gather' || !result.completeness) {
    const nouns = subjectNouns(deps.configuration);
    const kinds = nouns.length > 0 ? nouns.join(', ') : 'records';
    return {
      status: 'not_resolved',
      subject: input.subject,
      message: `No match for "${input.subject}" among the ${kinds} visible in this memory. Try munin_retrieve_context for an open search.`,
    };
  }

  return {
    status: 'gathered',
    subject: result.completeness.subject,
    recordCount: result.completeness.recordCount,
    sources: result.sources.map(shapeSource),
    completenessNote: completenessBanner(
      result.completeness.subject,
      result.completeness.mayHaveUnlinkedRecords,
    ),
    citationGuidance: SOURCES_CITATION_GUIDANCE,
  };
}

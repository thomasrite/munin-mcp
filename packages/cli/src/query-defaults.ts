// Caller-side application of `Configuration.queryDefaults` (F-L1).
//
// Retrieval is corpus-sensitive: dense/long-form text (e.g. legislation)
// retrieves better with a looser cosine cutoff and a larger top-k than the
// engine's natural-language defaults. A configuration ships recommended values
// in `queryDefaults`; this maps the defined ones onto the QueryPipeline's
// caller-level options. Only defined fields are forwarded, so each unset knob
// falls back to the engine's built-in default. The engine query layer stays
// configuration-agnostic — it takes raw numbers, never a Configuration.

import type { QueryPipelineOptions } from '@muninhq/engine';
import type { Configuration } from '@muninhq/shared';

type RetrievalOptions = Partial<
  Pick<
    QueryPipelineOptions,
    | 'k'
    | 'maxParagraphs'
    | 'distanceThreshold'
    | 'tokenCeiling'
    | 'expansionBreadth'
    | 'keywordWeight'
    | 'keywordK'
    | 'rerankCandidates'
    | 'recencyHalfLifeDays'
    | 'supersededDemotionFactor'
  >
>;

export function queryOptionsFromConfig(configuration: Configuration): RetrievalOptions {
  const d = configuration.queryDefaults;
  if (!d) return {};
  return {
    ...(d.k !== undefined ? { k: d.k } : {}),
    ...(d.maxParagraphs !== undefined ? { maxParagraphs: d.maxParagraphs } : {}),
    ...(d.distanceThreshold !== undefined ? { distanceThreshold: d.distanceThreshold } : {}),
    ...(d.tokenCeiling !== undefined ? { tokenCeiling: d.tokenCeiling } : {}),
    ...(d.expansionBreadth !== undefined ? { expansionBreadth: d.expansionBreadth } : {}),
    ...(d.keywordWeight !== undefined ? { keywordWeight: d.keywordWeight } : {}),
    ...(d.keywordK !== undefined ? { keywordK: d.keywordK } : {}),
    ...(d.rerankCandidates !== undefined ? { rerankCandidates: d.rerankCandidates } : {}),
    ...(d.recencyHalfLifeDays !== undefined ? { recencyHalfLifeDays: d.recencyHalfLifeDays } : {}),
    ...(d.supersededDemotionFactor !== undefined
      ? { supersededDemotionFactor: d.supersededDemotionFactor }
      : {}),
  };
}

// Caller-side application of `Configuration.queryDefaults` (F-L1).
//
// DUPLICATED from packages/cli/src/query-defaults.ts (the source of record for
// this mapping) rather than lifted to @muninhq/shared: the return type is a pick
// of the engine-tier QueryPipelineOptions, and shared must not import engine.
// A duck-typed copy in shared would drift exactly the way this copy can, while
// adding a cross-tier dependency — so we keep the ~40 lines here with this
// pointer instead. If the knob list changes, change both files.
//
// Only defined fields are forwarded, so each unset knob falls back to the
// engine's built-in default. The engine query layer stays configuration-
// agnostic — it takes raw numbers, never a Configuration.

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
